import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { Interval } from '@nestjs/schedule';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService, SuiLzEvent } from '../chain/sui/sui.service';
import { SuiCheckpointService } from '../chain/sui/sui-checkpoint.service';
import { SuiLzService } from '../chain/sui/sui-lz.service';
import { SolanaService } from '../chain/solana/solana.service';
import { WalrusService } from '../walrus/walrus.service';
import { WalTopUpService } from '../walrus/wal-topup.service';
import { MetricsService } from '../metrics/metrics.service';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { IntentCommitment } from '../lifecycle/intent-lifecycle.types';
import { HopDetails, IntentHop } from '../lifecycle/intent-lifecycle.types';
import { ErrorReporter } from '../observability/error-reporter';
import { StagedIntentStore } from '../staged/staged-intent.store';
import { StagedIntentRow } from '../staged/staged-intent.types';
import { blobIdMatches, walrusBlobIdToField } from '../common/walrus-blob-id';
import { CLAIM_INTERVAL_MS } from '../common/constants';

/**
 * Marker stored in store_digest when execute_store aborts with
 * EIntentAlreadyExecuted (a prior attempt recorded this intent on Sui). It lets
 * a retry skip the re-record without a real digest, and keeps the column
 * non-null so the idempotency guard fires.
 */
const ALREADY_RECORDED = 'already-recorded';

/**
 * Drives the durable store queue.
 *
 *   Sui IntentReceived (checkpoint)  ->  staged_intent.markReceived()
 *   POST /blob (ingest)              ->  staged_intent.upsertBytes()
 *   this loop (@CLAIM_INTERVAL_MS)   ->  drainDue() -> store() each ready row
 *
 * Single-writer: one process, bounded concurrency (STORE_CONCURRENCY), no
 * SKIP LOCKED / lease. The only in-memory state is `inProcess`, a guard so the
 * loop never double-starts the same intent within this process.
 *
 * store() is per-step idempotent: the persisted walrus_object_id / store_digest
 * make a crash or retry re-run only the unfinished steps, so a slow or restarted
 * store never re-uploads (no double WAL spend) or re-records. Bytes are freed
 * once the blob is safe on Walrus and recorded on Sui.
 *
 * Durable-only: without DATABASE_URL the queue is disabled (staged is null) and
 * this loop is inert; the relayer needs Postgres to process intents.
 */
@Injectable()
export class IntentProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentProcessor.name);
  /** Intents being stored right now in this process (double-start guard). */
  private readonly inProcess = new Set<string>();
  private readonly evmDstEid: number;
  private readonly solanaSrcEid: number;
  private readonly storeConcurrency: number;
  private readonly batchSize: number;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly maxStoreAttempts: number;
  private readonly returnMaxAttempts: number;
  private readonly attemptTimeoutMs: number;
  private readonly shutdownDrainMs: number;
  private stopped = false;
  private ticking = false;

  constructor(
    private readonly evm: EvmService,
    private readonly sui: SuiService,
    private readonly suiCheckpoint: SuiCheckpointService,
    private readonly suiLz: SuiLzService,
    private readonly solana: SolanaService,
    private readonly walrus: WalrusService,
    private readonly walTopUp: WalTopUpService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly lifecycle: IntentLifecycleStore,
    private readonly errorReporter: ErrorReporter,
    // The durable queue. Null without DATABASE_URL; the loop then stays inert.
    // Explicit @Inject because the `| null` union erases DI type metadata.
    @Optional() @Inject(StagedIntentStore) private readonly staged: StagedIntentStore | null = null,
  ) {
    this.evmDstEid = this.config.getOrThrow<number>('EVM_DST_EID');
    this.solanaSrcEid = this.config.get<number>('SOLANA_SRC_EID') ?? 40168;
    this.storeConcurrency = this.config.get<number>('STORE_CONCURRENCY') ?? 4;
    this.batchSize = this.config.get<number>('STORE_BATCH_SIZE') ?? 20;
    this.backoffBaseMs = this.config.get<number>('STORE_BACKOFF_BASE_MS') ?? 2000;
    this.backoffCapMs = this.config.get<number>('STORE_BACKOFF_CAP_MS') ?? 300000;
    this.maxStoreAttempts = this.config.get<number>('MAX_STORE_ATTEMPTS') ?? 8;
    this.returnMaxAttempts = this.config.get<number>('RETURN_MAX_ATTEMPTS') ?? 20;
    this.attemptTimeoutMs = this.config.get<number>('STORE_ATTEMPT_TIMEOUT_MS') ?? 120000;
    this.shutdownDrainMs = this.config.get<number>('SHUTDOWN_DRAIN_MS') ?? 30000;
  }

  async onModuleInit(): Promise<void> {
    const block = await this.evm.getBlockNumber();
    this.logger.log(`EVM connected at block ${block}`);
    this.logger.log(`Sui relayer: ${this.sui.getAddress()}`);
    this.logger.log(`LZ package: ${this.sui.getLzPackageId() || '(not configured)'}`);

    if (!this.staged) {
      this.logger.warn(
        'Durable store queue disabled (DATABASE_URL not set) - intents will NOT be processed',
      );
    } else {
      this.logger.log('Fulfilling intents from the durable store queue (staged_intent)');
    }

    // Register the checkpoint callback before streaming so backfill events are
    // not dropped. The callback only durably records the event; storage is done
    // by the claim loop.
    this.suiCheckpoint.setOnEventCallback((event) => this.onReceived(event));
    this.suiCheckpoint.startStreaming();
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Shutting down intent processor...');
    this.stopped = true;
    this.suiCheckpoint.stop();
    // Bounded graceful drain: give in-flight stores up to SHUTDOWN_DRAIN_MS to
    // settle so none is cut mid-flight, but never block shutdown past the budget.
    // Any row still active on exit resumes idempotently on next boot (the
    // persisted per-step results mean no re-upload / re-record).
    const deadline = Date.now() + this.shutdownDrainMs;
    while (this.inProcess.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (this.inProcess.size > 0) {
      this.logger.warn(
        `Shutdown drain timed out after ${this.shutdownDrainMs}ms with ` +
          `${this.inProcess.size} store(s) in flight; they resume on next boot`,
      );
    }
    this.logger.log('Intent processor stopped');
  }

  /**
   * Sui IntentReceived: durably flag the row so the claim loop can store it once
   * its bytes and committed sender are available. Order-independent - the bytes
   * may arrive before or after this event.
   */
  async onReceived(event: SuiLzEvent): Promise<void> {
    if (!this.staged) return;
    try {
      await this.staged.markReceived(event.intentId, {
        srcEid: event.srcEid,
        committedBlobId: u256ToHex(event.committedBlobId),
        deadline: Number(event.deadline) * 1000, // seconds -> ms
      });
      this.logger.log(`[${event.intentId}] IntentReceived recorded (src_eid ${event.srcEid})`);
    } catch (err) {
      this.logger.error(`[${event.intentId}] Failed to record IntentReceived: ${err}`);
      this.errorReporter.captureException(err, { intentId: event.intentId });
    }
  }

  /**
   * Claim loop: drain due rows, store the ready ones with bounded concurrency.
   * A single non-reentrant tick (guarded by `ticking`) - a long store carries
   * over ticks via `inProcess`, it does not stack.
   */
  @Interval(CLAIM_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.stopped || !this.staged || this.ticking) return;
    this.ticking = true;
    try {
      const now = Date.now();
      const rows = await this.staged.drainDue(now, this.batchSize);
      const ready: { row: StagedIntentRow; sender: string; commitment: IntentCommitment | null }[] = [];
      for (const row of rows) {
        if (ready.length >= this.storeConcurrency) break;
        if (this.inProcess.has(row.intentId)) continue;
        if (!row.received || !row.hasBytes) continue;
        // Past-deadline rows are left for the reaper to expire.
        if (row.deadline != null && now >= row.deadline) continue;
        // original_sender for execute_store comes from the EVM/Solana commitment
        // (single source of truth in the lifecycle store), not duplicated here.
        const commitment = await this.lifecycle.getCommitment(row.intentId);
        const sender = commitment?.sender;
        if (!sender) continue;
        ready.push({ row, sender, commitment });
      }
      await Promise.allSettled(ready.map((r) => this.runStore(r.row, r.sender, r.commitment)));
    } catch (err) {
      this.logger.error(`Claim tick failed: ${err}`);
      this.errorReporter.captureException(err);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Claim the in-process slot, store with a per-attempt timeout, and on failure
   * classify + retry. Two failure domains, deliberately not conflated:
   *   pre-store  (blob not yet on Walrus+Sui): bounded; dead-letter at MAX.
   *   post-store (return leg; blob already safe): never dead-letters storage,
   *              retries with a generous budget and alerts past it.
   * Per-step idempotency makes every retry cheap (no re-upload, no re-record).
   */
  private async runStore(
    row: StagedIntentRow,
    sender: string,
    commitment: IntentCommitment | null,
  ): Promise<void> {
    const intentId = row.intentId;
    this.inProcess.add(intentId);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.inProcess.delete(intentId);
      }
    };
    // The store settling always releases the slot, even if a timeout already
    // returned control below - so a timed-out-but-still-running store is never
    // re-picked concurrently (which could double-upload).
    const work = this.store(row, sender, commitment).finally(release);

    try {
      await withTimeout(work, this.attemptTimeoutMs);
      this.metrics.recordIntentProcessed('sui_lz', 'success');
      this.logger.log(`[${intentId}] Intent fulfilled`);
      return;
    } catch (err) {
      // Only release now if the store itself settled (not a still-running
      // timeout, whose .finally(release) fires when the work actually ends).
      if (!(err instanceof TimeoutError)) release();
      this.metrics.recordIntentProcessed('sui_lz', 'failure');
      this.errorReporter.captureException(err, { intentId });

      const attempts = row.attempts + 1;
      const backoff = Math.min(this.backoffBaseMs * 2 ** attempts, this.backoffCapMs);
      const nextAt = Date.now() + backoff;

      if (err instanceof StoreError && err.phase === 'post') {
        // Storage is safe; keep retrying the return leg. Never dead-letter it.
        await this.staged!.reschedule(intentId, attempts, nextAt, String(err));
        if (attempts >= this.returnMaxAttempts) {
          this.metrics.recordDeadLetter('return');
          this.logger.error(
            `[${intentId}] Stored but proof undelivered after ${attempts} attempts: ${err}`,
          );
        } else {
          this.logger.warn(`[${intentId}] Return leg failed (attempt ${attempts}): ${err}`);
        }
        return;
      }

      // Pre-store (or timeout): bounded, dead-letter once attempts are exhausted.
      if (attempts >= this.maxStoreAttempts) {
        await this.staged!.markDead(intentId, `pre-store attempts exhausted (${attempts}): ${err}`);
        this.metrics.recordDeadLetter('pre_store');
        this.logger.error(`[${intentId}] Dead-lettered after ${attempts} attempts: ${err}`);
      } else {
        await this.staged!.reschedule(intentId, attempts, nextAt, String(err));
        this.logger.error(`[${intentId}] Store failed (attempt ${attempts}): ${err}`);
      }
    }
  }

  /**
   * Per-step idempotent store pipeline. Each step persists its result before the
   * next, so a crash/retry resumes without repeating work or double-paying WAL.
   */
  private async store(
    row: StagedIntentRow,
    sender: string,
    commitment: IntentCommitment | null,
  ): Promise<void> {
    const staged = this.staged!;
    const intentId = row.intentId;

    // 1. Re-verify the recomputed blob id equals the commitment BEFORE any spend.
    // A mismatch is terminal (the buffered bytes are not what was committed).
    const committedRef = commitment?.committedBlobId ?? row.committedBlobId ?? '0x' + '00'.repeat(32);
    if (!blobIdMatches(row.blobId ?? '', committedRef)) {
      await staged.markDead(
        intentId,
        `blob id ${row.blobId} does not match committed reference ${committedRef}`,
      );
      this.logger.warn(`[${intentId}] Dead-lettered: blob id mismatch`);
      return;
    }

    // 0. Ensure the relayer holds enough WAL to pay for storage.
    await this.walTopUp.ensureWal();
    await this.trackHop(intentId, 'received', { sender });

    // 2. Upload to Walrus (idempotent: skip if a prior attempt already uploaded).
    let walrusBlobId: string;
    let walrusObjectId: string;
    let endEpoch: number;
    if (!row.walrusObjectId) {
      const bytes = await staged.fetchBytes(intentId);
      if (!bytes) throw new Error('ready row has no bytes to upload');
      this.logger.log(`[${intentId}] Uploading ingested bytes to Walrus...`);
      const uploadStart = Date.now();
      const info = await this.walrus.upload(bytes);
      this.metrics.observeWalrusUpload((Date.now() - uploadStart) / 1000);
      await staged.persistUpload(intentId, {
        walrusObjectId: info.suiObjectId,
        walrusBlobId: info.blobId,
        endEpoch: info.endEpoch,
      });
      if (info.walCostMist !== undefined) {
        this.metrics.recordWalStorageCost(Number(info.walCostMist));
      }
      walrusBlobId = info.blobId;
      walrusObjectId = info.suiObjectId;
      endEpoch = info.endEpoch;
      this.logger.log(`[${intentId}] Walrus blobId: ${walrusBlobId} (object ${walrusObjectId})`);
    } else {
      walrusBlobId = row.walrusBlobId!;
      walrusObjectId = row.walrusObjectId;
      endEpoch = row.endEpoch!;
      this.logger.log(`[${intentId}] Reusing prior Walrus upload ${walrusObjectId} (no re-spend)`);
    }
    await this.trackHop(intentId, 'stored_walrus', {
      blobId: walrusBlobId,
      suiObjectId: walrusObjectId,
      endEpoch,
    });

    // 3. Record on Sui (idempotent: skip if a prior attempt already recorded).
    let storeDigest = row.storeDigest;
    if (!storeDigest) {
      const deadlineMs = BigInt(row.deadline ?? Number(commitment?.deadline ?? 0));
      try {
        storeDigest = await this.sui.executeStore(intentId, sender, walrusObjectId, deadlineMs);
        await this.sui.getClient().core.waitForTransaction({ digest: storeDigest });
      } catch (err) {
        const msg = String(err);
        // EIntentAlreadyExecuted (abort code 2): a prior attempt recorded it.
        if (msg.includes('execute_store') && (msg.includes(', 2)') || msg.includes('abort code: 2'))) {
          this.logger.log(`[${intentId}] execute_store already done, proceeding`);
          storeDigest = ALREADY_RECORDED;
        } else {
          throw err;
        }
      }
      await staged.persistStore(intentId, storeDigest);
    }
    await this.trackHop(intentId, 'recorded_sui', {
      txHash: storeDigest === ALREADY_RECORDED ? undefined : storeDigest,
    });

    // 4. Blob is safe on Walrus + recorded on Sui: free the bytes.
    await staged.freeBytes(intentId);

    // 5. Return leg (idempotent: skip if already returned). A failure here is
    // POST-store: the blob is safe and WAL is spent, so the retry never
    // re-uploads or re-records and never dead-letters the storage. Marked with a
    // StoreError phase so runStore classifies it correctly.
    if (!row.returned) {
      try {
        if (row.srcEid === this.solanaSrcEid) {
          const canonical = '0x' + walrusBlobIdToField(walrusBlobId).toString('hex');
          await this.returnToSolana(intentId, canonical, endEpoch);
        } else {
          await this.returnToEvm(intentId, walrusBlobId, endEpoch);
        }
      } catch (retErr) {
        throw new StoreError(String(retErr), 'post');
      }
      await staged.markReturned(intentId);
    }

    // 6. Settle.
    await staged.markDone(intentId);
  }

  /**
   * EVM-origin return leg: deliver the execution proof back over LayerZero. The
   * quoted fee is authoritative (never a fabricated fallback). If the LZ send
   * path is unavailable, fall back to the owner-gated confirmExecution hybrid so
   * the EVM intent still gets marked executed with identical proof bytes.
   */
  private async returnToEvm(
    intentId: string,
    walrusBlobId: string,
    endEpoch: number,
  ): Promise<void> {
    try {
      const quotedFee = await this.suiLz.quoteLzFee(intentId, walrusBlobId, endEpoch, this.evmDstEid);
      // 10% buffer for price drift between quote and send.
      const feeAmount = (quotedFee * 11n) / 10n;
      this.logger.log(`[${intentId}] LZ fee quote: ${quotedFee} MIST (using ${feeAmount})`);
      this.logger.log(`[${intentId}] Sending LZ proof to EVM (dstEid: ${this.evmDstEid})...`);
      const lzDigest = await this.suiLz.lzSendProof(
        intentId,
        walrusBlobId,
        endEpoch,
        this.evmDstEid,
        feeAmount,
      );
      this.metrics.recordLzSend('success');
      this.logger.log(`[${intentId}] LZ proof sent: ${lzDigest}`);
      await this.trackHop(intentId, 'proof_sent', { txHash: lzDigest });
    } catch (lzErr) {
      this.metrics.recordLzSend('failure');
      this.logger.warn(
        `[${intentId}] LZ send-proof unavailable (${(lzErr as Error).message}); ` +
          `falling back to owner confirmExecution`,
      );
      // Same proof the LZ return would deliver: abi.encode(blobId, endEpoch) with
      // the canonical big-endian blob id, so IntentExecuted decodes identically.
      const canonicalBlobIdHex = '0x' + walrusBlobIdToField(walrusBlobId).toString('hex');
      const proof = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256'],
        [canonicalBlobIdHex, BigInt(endEpoch)],
      );
      const evmDigest = await this.evm.confirmExecution(intentId, proof);
      this.logger.log(`[${intentId}] Return confirmed via confirmExecution: ${evmDigest}`);
      await this.trackHop(intentId, 'proof_sent', { txHash: evmDigest });
    }
  }

  /**
   * Solana-origin return leg: record the execution result on the origin
   * IntentState via the adapter's owner-gated confirm_execution. The canonical LZ
   * proof path is blocked by the same LZ testnet infra fault as the EVM leg
   * (#272), so the trusted relayer confirms directly.
   */
  private async returnToSolana(
    intentId: string,
    canonicalBlobIdHex: string,
    endEpoch: number,
  ): Promise<void> {
    if (!this.solana.canConfirm()) {
      this.metrics.recordLzSend('failure');
      throw new Error(
        `[${intentId}] Solana-origin return leg requires a Solana signer ` +
          `(set SOLANA_RELAYER_KEYPAIR); cannot confirm_execution`,
      );
    }
    this.logger.log(`[${intentId}] Confirming execution on Solana (src_eid: ${this.solanaSrcEid})...`);
    const sig = await this.solana.confirmExecution(intentId, canonicalBlobIdHex, BigInt(endEpoch));
    this.metrics.recordLzSend('success');
    this.logger.log(`[${intentId}] Solana return confirmed: ${sig}`);
    await this.trackHop(intentId, 'proof_sent', { txHash: sig });
  }

  /**
   * Record a lifecycle hop for the public feed. Best-effort: a store failure is
   * logged but never propagates, so feed persistence can never break fulfillment.
   */
  private async trackHop(intentId: string, hop: IntentHop, details?: HopDetails): Promise<void> {
    try {
      await this.lifecycle.recordHop(intentId, hop, details);
    } catch (err) {
      this.logger.warn(`[${intentId}] Failed to record ${hop} hop: ${err}`);
    }
  }
}

/** A store failure tagged with the phase it occurred in, for retry classification. */
class StoreError extends Error {
  constructor(
    message: string,
    readonly phase: 'pre' | 'post',
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

/** Raised when a store attempt exceeds its per-attempt timeout. */
class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject with a TimeoutError if `promise` does not settle within `ms`. The
 * underlying work keeps running (JS has no cancellation); the caller keeps the
 * in-process slot until it truly settles so it is never re-driven concurrently.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`store attempt exceeded ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Convert a big-endian u256 (decimal string from the on-chain event) into a
 * 0x-prefixed 32-byte hex string, so it can be compared to a recomputed blob id
 * the same way the EVM commitment is.
 */
function u256ToHex(decimal: string): string {
  try {
    const hex = BigInt(decimal).toString(16).padStart(64, '0');
    return '0x' + hex;
  } catch {
    return '0x' + '00'.repeat(32);
  }
}
