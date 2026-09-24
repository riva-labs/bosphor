/**
 * Fakes for the relayer load generator's local mode. They replace ONLY the
 * external I/O around the real IntentProcessor (Walrus upload, Sui
 * execute_store + wait, LayerZero quote + send, EVM confirm, WAL top-up) with
 * configurable-latency stubs, plus an in-memory stand-in for the Postgres
 * durable queue. The processor, its per-step idempotency, the IoClock
 * accounting, the lifecycle store, and the metrics service are the real code.
 */
import type { StagedIntentRow } from '../../src/staged/staged-intent.types';

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** Per-call latency sources (ms) for each stubbed external dependency. */
export interface IoLatency {
  walrusUpload: () => number;
  suiExecuteStore: () => number;
  suiWait: () => number;
  lzQuote: () => number;
  lzSend: () => number;
  walTopUp: () => number;
}

/**
 * In-memory durable-queue stand-in with the StagedIntentStore surface the
 * IntentProcessor calls. `dbLatencyMs` optionally delays every call to model a
 * local Postgres round-trip; the processor does NOT count queue writes as
 * external I/O, so that delay lands in the compute figure (conservative).
 */
export class InMemoryStagedStore {
  readonly rows = new Map<string, StagedIntentRow>();
  private readonly bytes = new Map<string, Buffer>();
  // Active ids in claim order (seed order), so a drain is O(limit) rather than a
  // full scan + sort: the fake queue must not become the bottleneck it measures.
  private readonly active = new Set<string>();

  constructor(private readonly dbLatencyMs: () => number = () => 0) {}

  /** Seed a row that is received + has bytes (ready to store). Claim order = seed order. */
  seed(row: StagedIntentRow, bytes: Buffer): void {
    this.rows.set(row.intentId, { ...row });
    this.bytes.set(row.intentId, bytes);
    if (row.state === 'active') this.active.add(row.intentId);
  }

  private async db(): Promise<void> {
    await sleep(this.dbLatencyMs());
  }

  private patch(intentId: string, p: Partial<StagedIntentRow>): void {
    const row = this.rows.get(intentId);
    if (!row) throw new Error(`unknown staged row ${intentId}`);
    const next = { ...row, ...p, updatedAt: Date.now() };
    this.rows.set(intentId, next);
    if (next.state !== 'active') this.active.delete(intentId);
  }

  async drainDue(now: number, limit: number): Promise<StagedIntentRow[]> {
    await this.db();
    const out: StagedIntentRow[] = [];
    for (const id of this.active) {
      if (out.length >= limit) break;
      const r = this.rows.get(id)!;
      if (r.nextAttemptAt <= now) out.push({ ...r }); // snapshots, like a SELECT
    }
    return out;
  }

  async fetchBytes(intentId: string): Promise<Buffer | undefined> {
    await this.db();
    return this.bytes.get(intentId);
  }

  async persistUpload(
    intentId: string,
    up: { walrusObjectId: string; walrusBlobId: string; endEpoch: number },
  ): Promise<void> {
    await this.db();
    this.patch(intentId, up);
  }

  async persistStore(intentId: string, storeDigest: string): Promise<void> {
    await this.db();
    this.patch(intentId, { storeDigest });
  }

  async freeBytes(intentId: string): Promise<void> {
    await this.db();
    this.bytes.delete(intentId);
    this.patch(intentId, { hasBytes: false });
  }

  async markReturned(intentId: string): Promise<void> {
    await this.db();
    this.patch(intentId, { returned: true });
  }

  async markDone(intentId: string): Promise<void> {
    await this.db();
    this.patch(intentId, { state: 'done' });
  }

  async markDead(intentId: string, lastError: string): Promise<void> {
    await this.db();
    this.patch(intentId, { state: 'dead', lastError });
  }

  async reschedule(
    intentId: string,
    attempts: number,
    nextAt: number,
    lastError: string,
  ): Promise<void> {
    await this.db();
    this.patch(intentId, { attempts, nextAttemptAt: nextAt, lastError });
  }

  async markReceived(): Promise<void> {
    await this.db();
  }

  async claimForByteRecovery(): Promise<never[]> {
    return [];
  }

  async rescheduleByteRecovery(): Promise<void> {}

  count(state: StagedIntentRow['state']): number {
    if (state === 'active') return this.active.size;
    let n = 0;
    for (const r of this.rows.values()) if (r.state === state) n++;
    return n;
  }
}

/** Build the stubbed external services the IntentProcessor constructor takes. */
export function makeIoFakes(lat: IoLatency, walrusBlobId: string) {
  let seq = 0;
  const walrus = {
    async upload(bytes: Buffer) {
      await sleep(lat.walrusUpload());
      return {
        blobId: walrusBlobId,
        suiObjectId: `0xobj${(++seq).toString(16)}`,
        endEpoch: 42,
        walCostMist: BigInt(bytes.length),
      };
    },
    async fetchBlobFromAggregator(): Promise<Buffer> {
      throw new Error('byte recovery is not exercised by the load generator');
    },
  };
  const waitForTransaction = async () => {
    await sleep(lat.suiWait());
  };
  const sui = {
    async executeStore() {
      await sleep(lat.suiExecuteStore());
      return `0xstore${(++seq).toString(16)}`;
    },
    getClient: () => ({ core: { waitForTransaction } }),
    getAddress: () => '0xloadgen',
    getLzPackageId: () => '0xloadgen',
  };
  const suiLz = {
    async quoteLzFee() {
      await sleep(lat.lzQuote());
      return 1_000_000n;
    },
    async lzSendProof() {
      await sleep(lat.lzSend());
      return `0xlz${(++seq).toString(16)}`;
    },
  };
  const evm = {
    bootstrapBlockNumber: async () => 1,
    getBlockNumber: async () => 1,
    confirmExecution: async () => '0xevm',
  };
  const solana = {
    canConfirm: () => false,
    confirmExecution: async () => 'unused',
  };
  const walTopUp = {
    async ensureWal() {
      await sleep(lat.walTopUp());
    },
  };
  const suiCheckpoint = {
    setOnEventCallback: () => undefined,
    startStreaming: () => undefined,
    stop: () => undefined,
  };
  return { walrus, sui, suiLz, evm, solana, walTopUp, suiCheckpoint };
}

/** A ConfigService stand-in backed by a plain object. */
export function makeConfig(values: Record<string, unknown>) {
  return {
    get: (k: string, d?: unknown) => (k in values ? values[k] : d),
    getOrThrow: (k: string) => {
      if (!(k in values)) throw new Error(`missing config ${k}`);
      return values[k];
    },
  };
}
