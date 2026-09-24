import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { MetricsService } from '../metrics/metrics.service';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { StagedIntentStore } from '../staged/staged-intent.store';
import { StagedIntentRow } from '../staged/staged-intent.types';
import { StorageOpLedgerStore } from './storage-op-ledger.store';
import { StorageOpEntry } from './storage-op-ledger.types';
import { LEDGER_BACKFILL_INTERVAL_MS } from '../common/constants';

/**
 * Marker the processor writes to store_digest when execute_store reports the
 * intent was already recorded by an earlier attempt. It is not a real digest, so
 * the ledger stores null for it.
 */
export const ALREADY_RECORDED = 'already-recorded';

/** What the store pipeline knows at the moment execute_store has succeeded. */
export interface CompletedStore {
  row: StagedIntentRow;
  /** Origin-chain sender from the commitment, if known. */
  sender?: string | null;
  /** Committed blob id (0x hex) from the commitment, else the staged row's. */
  committedBlobId?: string | null;
  walrusBlobId?: string | null;
  walrusObjectId?: string | null;
  endEpoch?: number | null;
  storeDigest?: string | null;
}

/**
 * Build the ledger entry for a completed store. Pure, so the mapping (and its
 * fallbacks) is unit tested without a database. Every value comes from the
 * staged row or the commitment; nothing is invented. `storedAt` prefers the
 * execute_store time persisted on the row, then the row's last update (the
 * best real completion time known for rows that predate stored_at).
 */
export function buildLedgerEntry(
  done: CompletedStore,
  network: string,
  now: number,
): StorageOpEntry {
  const { row } = done;
  const digest = done.storeDigest ?? row.storeDigest ?? null;
  return {
    intentId: row.intentId,
    srcEid: row.srcEid ?? null,
    sender: done.sender ?? null,
    size: row.size ?? null,
    blobId: done.committedBlobId ?? row.committedBlobId ?? null,
    walrusBlobId: done.walrusBlobId ?? row.walrusBlobId ?? null,
    walrusObjectId: done.walrusObjectId ?? row.walrusObjectId ?? null,
    endEpoch: done.endEpoch ?? row.endEpoch ?? null,
    appId: row.appId ?? null,
    network,
    storeDigest: digest === ALREADY_RECORDED ? null : digest,
    createdAt: row.createdAt,
    storedAt: row.storedAt ?? (row.storeDigest ? row.updatedAt : now),
  };
}

/**
 * Writes completed stores to the durable ops ledger, exactly once per intent.
 *
 * Two write paths, both idempotent (the ledger insert is ON CONFLICT DO NOTHING
 * and the staged row carries a `ledgered` flag):
 *
 *   inline    the store pipeline calls recordCompletedStore() right after
 *             execute_store succeeds. It never throws: a ledger failure is logged
 *             and counted, and the store carries on untouched.
 *   backfill  a sweep (LEDGER_BACKFILL_INTERVAL_MS) picks up any completed store
 *             still not ledgered (an inline failure, a crash between the two
 *             writes, or rows that predate the ledger) and records it. The
 *             reaper keeps such rows until they are ledgered, so no op is lost.
 *
 * Inert without DATABASE_URL (both stores null).
 */
@Injectable()
export class StorageOpLedger {
  private readonly logger = new Logger(StorageOpLedger.name);
  private readonly network: string;
  private backfilling = false;

  constructor(
    config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly lifecycle: IntentLifecycleStore,
    // Explicit @Inject tokens: the `| null` unions erase DI type metadata.
    @Optional()
    @Inject(StorageOpLedgerStore)
    private readonly ledger: StorageOpLedgerStore | null = null,
    @Optional() @Inject(StagedIntentStore) private readonly staged: StagedIntentStore | null = null,
  ) {
    this.network = config.get<string>('SUI_NETWORK') ?? 'testnet';
  }

  /**
   * Record a completed store. Never throws. Returns true when the op is in the
   * ledger (newly or already), false when the write failed and is left for the
   * backfill sweep.
   */
  async recordCompletedStore(done: CompletedStore): Promise<boolean> {
    if (!this.ledger) return false;
    const intentId = done.row.intentId;
    try {
      const entry = buildLedgerEntry(done, this.network, Date.now());
      const inserted = await this.ledger.record(entry);
      if (inserted) this.metrics.recordLedgerOp(entry.srcEid, entry.appId, entry.size ?? 0);
      await this.staged?.markLedgered(intentId);
      return true;
    } catch (err) {
      // Never fail the store over bookkeeping. The row stays un-ledgered, so the
      // backfill sweep retries it and the reaper keeps it until then.
      this.metrics.recordLedgerWriteFailure();
      this.logger.warn(`[${intentId}] Ops-ledger write failed (backfill will retry): ${err}`);
      return false;
    }
  }

  /** Backfill completed stores the ledger has not recorded yet. */
  @Interval(LEDGER_BACKFILL_INTERVAL_MS)
  async backfill(limit = 50): Promise<number> {
    if (!this.ledger || !this.staged || this.backfilling) return 0;
    this.backfilling = true;
    let recorded = 0;
    try {
      const rows = await this.staged.pendingLedger(limit);
      for (const row of rows) {
        let sender: string | null = null;
        let committedBlobId: string | null = null;
        try {
          const c = await this.lifecycle.getCommitment(row.intentId);
          sender = c?.sender ?? null;
          committedBlobId = c?.committedBlobId ?? null;
        } catch (err) {
          // The sender lives in the lifecycle store; without it, retry later
          // rather than record a partial row forever.
          this.logger.warn(`[${row.intentId}] Ledger backfill: commitment unavailable: ${err}`);
          continue;
        }
        if (await this.recordCompletedStore({ row, sender, committedBlobId })) recorded++;
      }
      if (recorded > 0) this.logger.log(`Ops-ledger backfill recorded ${recorded} store(s)`);
    } catch (err) {
      this.logger.error(`Ops-ledger backfill failed: ${err}`);
    } finally {
      this.backfilling = false;
    }
    return recorded;
  }
}
