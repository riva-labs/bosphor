import { Injectable, Logger } from '@nestjs/common';
import {
  ReceivedDetails,
  StagedBytes,
  StagedIntentRow,
  StagedStats,
  UploadResult,
} from './staged-intent.types';

/**
 * The slice of a node-postgres Pool this store needs. Narrowed to a single
 * method so the store is trivially testable with a fake, matching the pattern in
 * PgIntentLifecycleStore.
 */
export interface PgQueryable {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}

const TABLE = 'staged_intent';

/**
 * Postgres-backed durable store queue. One row per intent; the raw bytes live in
 * a BYTEA column until the blob is safely on Walrus and recorded on Sui, then are
 * nulled to reclaim space. This is a pure data-access layer - scheduling,
 * classification, and the store pipeline live in the processor (later slices).
 *
 *   ingest   -> upsertBytes()   (bytes + blob_id + size)
 *   Sui LZ   -> markReceived()  (received + src_eid + committed_blob_id + deadline)
 *   loop     -> drainDue() -> fetchBytes() -> persistUpload()/persistStore()/
 *               markReturned() -> markDone() | reschedule() | markDead()
 *   reaper   -> expireDue() / purgeTerminal()
 *
 * Real data only: query failures propagate. Every mutating upsert is guarded
 * `WHERE state='active'` so a backfilled event can never resurrect a terminal
 * intent (replaces the old processedIntents dedup Map). All times are epoch ms.
 */
@Injectable()
export class StagedIntentStore {
  private readonly logger = new Logger(StagedIntentStore.name);

  constructor(private readonly pool: PgQueryable) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        intent_id         TEXT PRIMARY KEY,
        committed_blob_id TEXT,
        size              BIGINT,
        deadline          BIGINT,
        src_eid           INTEGER,
        received          BOOLEAN NOT NULL DEFAULT false,
        bytes             BYTEA,
        blob_id           TEXT,
        walrus_object_id  TEXT,
        walrus_blob_id    TEXT,
        end_epoch         BIGINT,
        store_digest      TEXT,
        returned          BOOLEAN NOT NULL DEFAULT false,
        state             TEXT NOT NULL DEFAULT 'active',
        attempts          INTEGER NOT NULL DEFAULT 0,
        next_attempt_at   BIGINT NOT NULL,
        last_error        TEXT,
        created_at        BIGINT NOT NULL,
        updated_at        BIGINT NOT NULL
      )
    `);
    // Drives the claim/drain query: active rows that are due, oldest first.
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_drain_idx ON ${TABLE} (state, next_attempt_at, created_at)`,
    );
    this.logger.log('staged_intent table ready');
  }

  /**
   * Buffer accepted out-of-band bytes for `intentId`. Creates the row if the
   * IntentReceived event has not landed yet, otherwise merges the bytes onto the
   * existing active row. No-op on a terminal row (`WHERE state='active'`).
   */
  async upsertBytes(intentId: string, blob: StagedBytes): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO ${TABLE}
         (intent_id, bytes, blob_id, size, next_attempt_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5, $5)
       ON CONFLICT (intent_id) DO UPDATE SET
         bytes = EXCLUDED.bytes,
         blob_id = EXCLUDED.blob_id,
         size = EXCLUDED.size,
         updated_at = EXCLUDED.updated_at
       WHERE ${TABLE}.state = 'active'`,
      [intentId, blob.bytes, blob.blobId, blob.size, now],
    );
  }

  /**
   * Record that the Sui IntentReceived event fired for `intentId`. Creates the
   * row if the bytes have not landed yet, otherwise flags the existing active
   * row. No-op on a terminal row.
   */
  async markReceived(intentId: string, details: ReceivedDetails): Promise<void> {
    const now = Date.now();
    await this.pool.query(
      `INSERT INTO ${TABLE}
         (intent_id, received, src_eid, committed_blob_id, deadline,
          next_attempt_at, created_at, updated_at)
       VALUES ($1, true, $2, $3, $4, $5, $5, $5)
       ON CONFLICT (intent_id) DO UPDATE SET
         received = true,
         src_eid = EXCLUDED.src_eid,
         committed_blob_id = EXCLUDED.committed_blob_id,
         deadline = EXCLUDED.deadline,
         updated_at = EXCLUDED.updated_at
       WHERE ${TABLE}.state = 'active'`,
      [intentId, details.srcEid, details.committedBlobId, details.deadline, now],
    );
  }

  /**
   * Active rows that are due (`next_attempt_at <= now`), oldest first. Returns
   * metadata only - never the BYTEA payload - so the poll stays cheap.
   */
  async drainDue(now: number, limit: number): Promise<StagedIntentRow[]> {
    const { rows } = await this.pool.query(
      `SELECT intent_id, committed_blob_id, size, deadline, src_eid, received,
              (bytes IS NOT NULL) AS has_bytes, blob_id, walrus_object_id,
              walrus_blob_id, end_epoch, store_digest, returned, state, attempts,
              next_attempt_at, last_error, created_at, updated_at
         FROM ${TABLE}
        WHERE state = 'active' AND next_attempt_at <= $1
        ORDER BY created_at
        LIMIT $2`,
      [now, limit],
    );
    return rows.map((r) => this.mapRow(r));
  }

  /** Fetch the raw bytes for `intentId` (only when actually storing it). */
  async fetchBytes(intentId: string): Promise<Buffer | undefined> {
    const { rows } = await this.pool.query(
      `SELECT bytes FROM ${TABLE} WHERE intent_id = $1`,
      [intentId],
    );
    const raw = rows.length ? (rows[0].bytes as Buffer | null) : null;
    return raw ?? undefined;
  }

  /** Persist a successful Walrus upload so a retry never re-uploads (no double WAL). */
  async persistUpload(intentId: string, up: UploadResult): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE}
          SET walrus_object_id = $2, walrus_blob_id = $3, end_epoch = $4, updated_at = $5
        WHERE intent_id = $1`,
      [intentId, up.walrusObjectId, up.walrusBlobId, up.endEpoch, Date.now()],
    );
  }

  /** Persist a successful execute_store so a retry never re-records on Sui. */
  async persistStore(intentId: string, storeDigest: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE} SET store_digest = $2, updated_at = $3 WHERE intent_id = $1`,
      [intentId, storeDigest, Date.now()],
    );
  }

  /** Mark the return-leg proof confirmed. */
  async markReturned(intentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE} SET returned = true, updated_at = $2 WHERE intent_id = $1`,
      [intentId, Date.now()],
    );
  }

  /** Free the bytes once the blob is safe on Walrus + recorded on Sui. */
  async freeBytes(intentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE} SET bytes = NULL, updated_at = $2 WHERE intent_id = $1`,
      [intentId, Date.now()],
    );
  }

  /** Terminal success: bytes freed, row settled. */
  async markDone(intentId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE} SET state = 'done', bytes = NULL, updated_at = $2 WHERE intent_id = $1`,
      [intentId, Date.now()],
    );
  }

  /** Terminal failure (attempts exhausted / terminal error): bytes freed, reason kept. */
  async markDead(intentId: string, lastError: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE}
          SET state = 'dead', bytes = NULL, last_error = $2, updated_at = $3
        WHERE intent_id = $1`,
      [intentId, lastError, Date.now()],
    );
  }

  /** Transient retry: bump attempts and gate the next claim behind a backoff. */
  async reschedule(
    intentId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE}
          SET attempts = $2, next_attempt_at = $3, last_error = $4, updated_at = $5
        WHERE intent_id = $1`,
      [intentId, attempts, nextAttemptAt, lastError, Date.now()],
    );
  }

  /**
   * Aggregate staged bytes for backpressure. Sums the `size` column (not the
   * BYTEA payload) so it never de-TOASTs; only rows that still hold bytes count.
   */
  async stagedBytesTotal(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(size), 0) AS total FROM ${TABLE} WHERE bytes IS NOT NULL`,
    );
    return Number(rows[0]?.total ?? 0);
  }

  /**
   * Queue-depth snapshot for the metrics gauges, in one aggregate scan:
   * `active` rows still in play, `dead` rows dead-lettered, and `bytes` the total
   * committed size still held in BYTEA (summed from the `size` column, never the
   * payload, so it does not de-TOAST).
   */
  async stats(): Promise<StagedStats> {
    const { rows } = await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE state = 'active') AS active,
         COUNT(*) FILTER (WHERE state = 'dead') AS dead,
         COALESCE(SUM(size) FILTER (WHERE bytes IS NOT NULL), 0) AS bytes
       FROM ${TABLE}`,
    );
    const r = rows[0] ?? {};
    return {
      active: Number(r.active ?? 0),
      dead: Number(r.dead ?? 0),
      bytes: Number(r.bytes ?? 0),
    };
  }

  /**
   * Expire active rows whose deadline has passed before they stored. Frees bytes.
   * Returns the number expired.
   */
  async expireDue(now: number): Promise<number> {
    const { rows } = await this.pool.query(
      `UPDATE ${TABLE}
          SET state = 'expired', bytes = NULL, updated_at = $1
        WHERE state = 'active' AND deadline IS NOT NULL AND deadline < $1
        RETURNING intent_id`,
      [now],
    );
    return rows.length;
  }

  /** Delete terminal rows older than `cutoff` (retention). Returns the number purged. */
  async purgeTerminal(cutoff: number): Promise<number> {
    const { rows } = await this.pool.query(
      `DELETE FROM ${TABLE}
        WHERE state IN ('done', 'dead', 'expired') AND updated_at < $1
        RETURNING intent_id`,
      [cutoff],
    );
    return rows.length;
  }

  /** Read a single row's metadata (no bytes). Used for inspection and tests. */
  async get(intentId: string): Promise<StagedIntentRow | undefined> {
    const { rows } = await this.pool.query(
      `SELECT intent_id, committed_blob_id, size, deadline, src_eid, received,
              (bytes IS NOT NULL) AS has_bytes, blob_id, walrus_object_id,
              walrus_blob_id, end_epoch, store_digest, returned, state, attempts,
              next_attempt_at, last_error, created_at, updated_at
         FROM ${TABLE} WHERE intent_id = $1`,
      [intentId],
    );
    return rows.length ? this.mapRow(rows[0]) : undefined;
  }

  private mapRow(row: Record<string, unknown>): StagedIntentRow {
    const num = (v: unknown): number | undefined =>
      v === null || v === undefined ? undefined : Number(v);
    const str = (v: unknown): string | undefined => (v as string | null) ?? undefined;
    return {
      intentId: row.intent_id as string,
      committedBlobId: str(row.committed_blob_id),
      size: num(row.size),
      deadline: num(row.deadline),
      srcEid: num(row.src_eid),
      received: Boolean(row.received),
      hasBytes: Boolean(row.has_bytes),
      blobId: str(row.blob_id),
      walrusObjectId: str(row.walrus_object_id),
      walrusBlobId: str(row.walrus_blob_id),
      endEpoch: num(row.end_epoch),
      storeDigest: str(row.store_digest),
      returned: Boolean(row.returned),
      state: row.state as StagedIntentRow['state'],
      attempts: Number(row.attempts ?? 0),
      nextAttemptAt: Number(row.next_attempt_at),
      lastError: str(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
