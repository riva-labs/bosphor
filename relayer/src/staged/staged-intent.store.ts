import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import {
  ByteRecoveryCandidate,
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
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const TABLE = 'staged_intent';

/** Default claim lease: 10 minutes, 5x the per-attempt store timeout. */
export const DEFAULT_LEASE_MS = 600_000;

/**
 * Tuning knobs for the claim lease. `claimant` identifies this process in
 * `claimed_by` (defaults to hostname plus a random suffix, generated once per
 * store instance, i.e. once per process). `leaseMs` is how long a claim stays
 * exclusive without renewal (STORE_LEASE_MS).
 */
export interface StagedStoreOptions {
  claimant?: string;
  leaseMs?: number;
}

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
 *
 * Single-writer is enforced HERE, by a database lease, not by deployment
 * discipline: drainDue() atomically claims the rows it returns (claimed_by +
 * lease_expires_at, FOR UPDATE SKIP LOCKED), so two relayer processes provably
 * get disjoint rows. A claimant re-claiming its own rows renews the lease; an
 * expired lease (crashed process) is claimable by anyone; reschedule() releases
 * the lease early. Terminal transitions keep claimed_by as a historical record,
 * the `state='active'` guard already excludes them from every claim.
 */
@Injectable()
export class StagedIntentStore {
  private readonly logger = new Logger(StagedIntentStore.name);
  /** This process's lease identity, recorded in claimed_by on every claim. */
  readonly claimant: string;
  private readonly leaseMs: number;

  constructor(
    private readonly pool: PgQueryable,
    options: StagedStoreOptions = {},
  ) {
    this.claimant = options.claimant ?? `${hostname()}-${randomBytes(4).toString('hex')}`;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        intent_id         TEXT PRIMARY KEY,
        committed_blob_id TEXT,
        size              BIGINT,
        deadline          BIGINT,
        src_eid           INTEGER,
        received          BOOLEAN NOT NULL DEFAULT false,
        delivery_digest   TEXT,
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
    // Additive migration for deployments created before delivery_digest existed.
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS delivery_digest TEXT`);
    // Additive migration: gate for the byte-recovery sweep (next allowed attempt).
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS bytes_recovery_at BIGINT`);
    // Additive migration: claim lease (single-writer enforcement). Nullable, so
    // existing rows are untouched and immediately claimable (claimed_by IS NULL).
    // lease_expires_at is epoch ms (BIGINT), matching every other timestamp in
    // this table and keeping the injected `now` the single clock source.
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS claimed_by TEXT`);
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS lease_expires_at BIGINT`);
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
         (intent_id, received, src_eid, committed_blob_id, deadline, delivery_digest,
          next_attempt_at, created_at, updated_at)
       VALUES ($1, true, $2, $3, $4, $6, $5, $5, $5)
       ON CONFLICT (intent_id) DO UPDATE SET
         received = true,
         src_eid = EXCLUDED.src_eid,
         committed_blob_id = EXCLUDED.committed_blob_id,
         deadline = EXCLUDED.deadline,
         delivery_digest = COALESCE(EXCLUDED.delivery_digest, ${TABLE}.delivery_digest),
         updated_at = EXCLUDED.updated_at
       WHERE ${TABLE}.state = 'active'`,
      [
        intentId,
        details.srcEid,
        details.committedBlobId,
        details.deadline,
        now,
        details.deliveryDigest ?? null,
      ],
    );
  }

  /**
   * Rows that are IntentReceived but still have no bytes, past the recovery grace
   * and not yet expired, whose recovery gate is due. These are candidates to
   * self-heal by re-fetching the committed blob from Walrus. The grace (measured
   * from row creation) gives the client's normal delivery a head start; after each
   * attempt the caller bumps `bytes_recovery_at` so a failing blob backs off.
   */
  async claimForByteRecovery(
    now: number,
    graceMs: number,
    limit: number,
  ): Promise<ByteRecoveryCandidate[]> {
    const { rows } = await this.pool.query(
      `SELECT intent_id, committed_blob_id
         FROM ${TABLE}
        WHERE state = 'active'
          AND received = true
          AND bytes IS NULL
          AND committed_blob_id IS NOT NULL
          AND (deadline IS NULL OR deadline > $1)
          AND COALESCE(bytes_recovery_at, created_at + $2) <= $1
        ORDER BY created_at
        LIMIT $3`,
      [now, graceMs, limit],
    );
    return rows.map((r) => ({
      intentId: r.intent_id as string,
      committedBlobId: r.committed_blob_id as string,
    }));
  }

  /** Back off the next byte-recovery attempt for a row (blob not yet fetchable). */
  async rescheduleByteRecovery(intentId: string, nextAt: number): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE} SET bytes_recovery_at = $2, updated_at = $3
        WHERE intent_id = $1 AND state = 'active'`,
      [intentId, nextAt, Date.now()],
    );
  }

  /**
   * Claim the active rows that are due (`next_attempt_at <= now`), oldest first.
   * Returns metadata only - never the BYTEA payload - so the poll stays cheap.
   *
   * This is the single-writer boundary: one atomic UPDATE stamps claimed_by and
   * lease_expires_at on the rows it returns. The subselect takes row locks with
   * FOR UPDATE SKIP LOCKED, so two processes claiming concurrently get disjoint
   * rows; a row already leased to a live foreign claimant is filtered out. Three
   * kinds of rows are claimable:
   *   unclaimed        claimed_by IS NULL (fresh rows, pre-lease rows)
   *   our own          claimed_by = claimant (re-claim renews the lease, which is
   *                    how an in-flight store longer than the lease stays covered:
   *                    the owning process re-drains every claim tick)
   *   expired          lease_expires_at < now (the claimant died mid-store;
   *                    takeover, and per-step idempotency makes the resume safe)
   */
  async drainDue(now: number, limit: number): Promise<StagedIntentRow[]> {
    const { rows } = await this.pool.query(
      `UPDATE ${TABLE}
          SET claimed_by = $3, lease_expires_at = $1 + $4, updated_at = $1
        WHERE intent_id IN (
          SELECT intent_id
            FROM ${TABLE}
           WHERE state = 'active' AND next_attempt_at <= $1
             AND (claimed_by IS NULL OR claimed_by = $3 OR lease_expires_at < $1)
           ORDER BY created_at
           LIMIT $2
           FOR UPDATE SKIP LOCKED
        )
        RETURNING intent_id, committed_blob_id, size, deadline, src_eid, received,
              delivery_digest, (bytes IS NOT NULL) AS has_bytes, blob_id,
              walrus_object_id, walrus_blob_id, end_epoch, store_digest, returned,
              state, attempts, next_attempt_at, last_error, created_at, updated_at,
              claimed_by, lease_expires_at`,
      [now, limit, this.claimant, this.leaseMs],
    );
    // RETURNING does not guarantee the subselect's order; restore oldest-first.
    return rows.map((r) => this.mapRow(r)).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Fetch the raw bytes for `intentId` (only when actually storing it). */
  async fetchBytes(intentId: string): Promise<Buffer | undefined> {
    const { rows } = await this.pool.query(`SELECT bytes FROM ${TABLE} WHERE intent_id = $1`, [
      intentId,
    ]);
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

  /**
   * Terminal success: bytes freed, row settled. claimed_by stays as a historical
   * record of who processed the row; the `state='active'` guard in the claim
   * query is what keeps terminal rows out of every future claim.
   */
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

  /**
   * Transient retry: bump attempts and gate the next claim behind a backoff.
   * Also releases the claim lease, so once the backoff elapses ANY process may
   * pick the row up; nobody waits out a lease the owner is no longer using.
   */
  async reschedule(
    intentId: string,
    attempts: number,
    nextAttemptAt: number,
    lastError: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE ${TABLE}
          SET attempts = $2, next_attempt_at = $3, last_error = $4, updated_at = $5,
              claimed_by = NULL, lease_expires_at = NULL
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
              delivery_digest, (bytes IS NOT NULL) AS has_bytes, blob_id,
              walrus_object_id, walrus_blob_id, end_epoch, store_digest, returned,
              state, attempts, next_attempt_at, last_error, created_at, updated_at,
              claimed_by, lease_expires_at
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
      deliveryDigest: str(row.delivery_digest),
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
      claimedBy: str(row.claimed_by),
      leaseExpiresAt: num(row.lease_expires_at),
      lastError: str(row.last_error),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
