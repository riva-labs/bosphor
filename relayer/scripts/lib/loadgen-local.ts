/**
 * Local-mode core of the relayer load generator: builds the REAL IntentProcessor
 * around stubbed external I/O and an in-memory queue, seeds N ready intents, and
 * drives the claim loop until they settle. See scripts/loadgen.ts.
 */
import { IntentProcessor } from '../../src/intent/intent.processor';
import { MetricsService } from '../../src/metrics/metrics.service';
import { InMemoryIntentLifecycleStore } from '../../src/lifecycle/in-memory-intent-lifecycle.store';
import type { StagedIntentRow } from '../../src/staged/staged-intent.types';
import { makeLatency, ProfileResult, summarize, throughputPerSec } from './loadgen-stats';
import { InMemoryStagedStore, IoLatency, makeConfig, makeIoFakes } from './loadgen-fakes';

// A committed blob id and its base64url form: the processor re-verifies that
// the ingested blob id equals the on-chain commitment before any spend.
const COMMITTED_BYTES = Buffer.from('cd'.repeat(32), 'hex');
const COMMITTED_HEX = '0x' + COMMITTED_BYTES.toString('hex');
const COMMITTED_B64URL = COMMITTED_BYTES.toString('base64url');
const EVM_SRC_EID = 40161;
const SOLANA_SRC_EID = 40168;

/** MetricsService that also keeps the raw per-intent latency observations. */
export class CapturingMetrics extends MetricsService {
  readonly computeMs: number[] = [];
  readonly processingMs: number[] = [];
  succeeded = 0;
  failed = 0;

  override observeComputeLatency(seconds: number): void {
    super.observeComputeLatency(seconds);
    this.computeMs.push(seconds * 1000);
  }

  override observeProcessingLatency(seconds: number): void {
    super.observeProcessingLatency(seconds);
    this.processingMs.push(seconds * 1000);
  }

  override recordIntentProcessed(path: 'evm' | 'sui_lz', result: 'success' | 'failure'): void {
    super.recordIntentProcessed(path, result);
    if (result === 'success') this.succeeded++;
    else this.failed++;
  }
}

export interface LocalOptions {
  intents: number;
  warmup: number;
  blobBytes: number;
  solanaShare: number;
  dbMs: number;
  latency: { [K in keyof IoLatency]: number };
  jitterMs: number;
  seed: number;
  timeoutMs: number;
}

export async function runLocalProfile(
  concurrency: number,
  intents: number,
  o: LocalOptions,
): Promise<ProfileResult> {
  const lat = (base: number, salt: number) => makeLatency(base, o.jitterMs, o.seed + salt);
  const io: IoLatency = {
    walrusUpload: lat(o.latency.walrusUpload, 1),
    suiExecuteStore: lat(o.latency.suiExecuteStore, 2),
    suiWait: lat(o.latency.suiWait, 3),
    lzQuote: lat(o.latency.lzQuote, 4),
    lzSend: lat(o.latency.lzSend, 5),
    walTopUp: lat(o.latency.walTopUp, 6),
  };
  const fakes = makeIoFakes(io, COMMITTED_B64URL);
  const staged = new InMemoryStagedStore(makeLatency(o.dbMs, 0, o.seed));
  const lifecycle = new InMemoryIntentLifecycleStore();
  const metrics = new CapturingMetrics();
  const config = makeConfig({
    EVM_DST_EID: EVM_SRC_EID,
    SOLANA_SRC_EID,
    STORE_CONCURRENCY: concurrency,
    // The claim query must be allowed to return at least `concurrency` rows.
    STORE_BATCH_SIZE: Math.max(20, concurrency),
  });

  const now = Date.now();
  const bytes = Buffer.alloc(o.blobBytes, 0xab);
  const solanaEvery = o.solanaShare > 0 ? Math.round(1 / o.solanaShare) : 0;
  for (let i = 0; i < intents; i++) {
    const intentId = '0x' + (i + 1).toString(16).padStart(64, '0');
    const srcEid = solanaEvery > 0 && i % solanaEvery === 0 ? SOLANA_SRC_EID : EVM_SRC_EID;
    await lifecycle.recordHop(intentId, 'submitted', {
      sender: '0x' + 'ee'.repeat(20),
      committedBlobId: COMMITTED_HEX,
      size: o.blobBytes,
      deadline: now + 3_600_000,
    });
    const row: StagedIntentRow = {
      intentId,
      committedBlobId: COMMITTED_HEX,
      size: o.blobBytes,
      deadline: now + 3_600_000,
      srcEid,
      received: true,
      hasBytes: true,
      storageEpochs: 5,
      blobId: COMMITTED_B64URL,
      returned: false,
      state: 'active',
      attempts: 0,
      nextAttemptAt: 0,
      createdAt: now + i, // FIFO order
      updatedAt: now,
    };
    staged.seed(row, bytes);
  }

  const proc = new IntentProcessor(
    fakes.evm as never,
    fakes.sui as never,
    fakes.suiCheckpoint as never,
    fakes.suiLz as never,
    fakes.solana as never,
    fakes.walrus as never,
    fakes.walTopUp as never,
    config as never,
    metrics,
    lifecycle,
    { captureException: () => undefined } as never,
    staged as never,
    null, // ingest: bytes are pre-staged
    null, // waker: the load generator drives ticks directly
  );

  const started = Date.now();
  const deadline = started + o.timeoutMs;
  while (staged.count('active') > 0) {
    if (Date.now() > deadline)
      throw new Error(`profile c=${concurrency} timed out after ${o.timeoutMs}ms`);
    const before = metrics.succeeded + metrics.failed;
    await proc.tick();
    // No progress means every remaining row is backing off after a failure:
    // stop rather than spin, and report them as failed.
    if (metrics.succeeded + metrics.failed === before) break;
  }
  const wallMs = Date.now() - started;
  const done = staged.count('done');

  return {
    concurrency,
    intents,
    completed: done,
    failed: intents - done,
    wallMs,
    throughputPerSec: throughputPerSec(done, wallMs),
    compute: summarize(metrics.computeMs),
    processing: summarize(metrics.processingMs),
  };
}
