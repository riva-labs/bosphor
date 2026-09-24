import { Injectable, Logger } from '@nestjs/common';
import { StorageOpEntry } from './storage-op-ledger.types';

/**
 * The slice of a node-postgres Pool this store needs, matching the pattern in
 * StagedIntentStore / PgIntentLifecycleStore so it is testable with a fake.
 */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const LEDGER_TABLE = 'storage_op_ledger';

/**
 * Durable, append-only ledger of completed storage ops.
 *
 * Unlike staged_intent (reaped after STAGED_RETENTION_MS) and the Prometheus
 * counters (reset on restart), rows here are never deleted, so KPI windows can
 * be recomputed at any time from real data.
 *
 * Exactly-once: `intent_id` is the primary key and `record()` is an
 * `INSERT ... ON CONFLICT DO NOTHING`, so a retried store, a return-leg retry, or
 * the backfill sweep can call it any number of times and the first write wins.
 * `record()` reports whether THIS call inserted the row, which is what keeps the
 * Prometheus ledger counters from double counting.
 *
 * Real data only: query failures propagate to the caller.
 */
@Injectable()
export class StorageOpLedgerStore {
  private readonly logger = new Logger(StorageOpLedgerStore.name);

  constructor(private readonly pool: PgQueryable) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
        intent_id        TEXT PRIMARY KEY,
        src_eid          INTEGER,
        sender           TEXT,
        size             BIGINT,
        blob_id          TEXT,
        walrus_blob_id   TEXT,
        walrus_object_id TEXT,
        end_epoch        BIGINT,
        app_id           TEXT,
        network          TEXT NOT NULL,
        store_digest     TEXT,
        created_at       BIGINT NOT NULL,
        stored_at        BIGINT NOT NULL,
        recorded_at      BIGINT NOT NULL
      )
    `);
    // KPI windows filter on stored_at.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${LEDGER_TABLE}_stored_at_idx ON ${LEDGER_TABLE} (stored_at)`,
    );
    this.logger.log('storage_op_ledger table ready');
  }

  /**
   * Record a completed op. Idempotent on intent_id: returns true when this call
   * inserted the row, false when it was already recorded (no change).
   */
  async record(entry: StorageOpEntry): Promise<boolean> {
    const { rows } = await this.pool.query(
      `INSERT INTO ${LEDGER_TABLE}
         (intent_id, src_eid, sender, size, blob_id, walrus_blob_id, walrus_object_id,
          end_epoch, app_id, network, store_digest, created_at, stored_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (intent_id) DO NOTHING
       RETURNING intent_id`,
      [
        entry.intentId,
        entry.srcEid,
        entry.sender,
        entry.size,
        entry.blobId,
        entry.walrusBlobId,
        entry.walrusObjectId,
        entry.endEpoch,
        entry.appId,
        entry.network,
        entry.storeDigest,
        entry.createdAt,
        entry.storedAt,
        Date.now(),
      ],
    );
    return rows.length > 0;
  }

  /** Ops stored in `[sinceMs, untilMs)`, oldest first. Used by the KPI export. */
  async listStoredBetween(sinceMs: number, untilMs: number): Promise<StorageOpEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT intent_id, src_eid, sender, size, blob_id, walrus_blob_id, walrus_object_id,
              end_epoch, app_id, network, store_digest, created_at, stored_at
         FROM ${LEDGER_TABLE}
        WHERE stored_at >= $1 AND stored_at < $2
        ORDER BY stored_at`,
      [sinceMs, untilMs],
    );
    return rows.map(mapLedgerRow);
  }

  /** Read one entry (inspection and tests). */
  async get(intentId: string): Promise<StorageOpEntry | undefined> {
    const { rows } = await this.pool.query(
      `SELECT intent_id, src_eid, sender, size, blob_id, walrus_blob_id, walrus_object_id,
              end_epoch, app_id, network, store_digest, created_at, stored_at
         FROM ${LEDGER_TABLE} WHERE intent_id = $1`,
      [intentId],
    );
    return rows.length ? mapLedgerRow(rows[0]) : undefined;
  }
}

/** Map a raw ledger row (BIGINTs arrive as strings from pg) to an entry. */
export function mapLedgerRow(r: Record<string, unknown>): StorageOpEntry {
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const str = (v: unknown): string | null => (v as string | null | undefined) ?? null;
  return {
    intentId: r.intent_id as string,
    srcEid: num(r.src_eid),
    sender: str(r.sender),
    size: num(r.size),
    blobId: str(r.blob_id),
    walrusBlobId: str(r.walrus_blob_id),
    walrusObjectId: str(r.walrus_object_id),
    endEpoch: num(r.end_epoch),
    appId: str(r.app_id),
    network: r.network as string,
    storeDigest: str(r.store_digest),
    createdAt: Number(r.created_at),
    storedAt: Number(r.stored_at),
  };
}
