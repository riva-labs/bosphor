import { Injectable, Logger } from '@nestjs/common';
import { IntentLifecycleStore } from './intent-lifecycle.store';
import { applyHop } from './intent-lifecycle.merge';
import {
  HopDetails,
  IntentCommitment,
  IntentHop,
  IntentHopRecord,
  IntentLifecycleRecord,
} from './intent-lifecycle.types';

/**
 * The slice of a node-postgres Pool this store needs. Narrowed to a single
 * method so the store is trivially testable with a fake and does not couple to
 * the full pg surface.
 */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const TABLE = 'intent_lifecycle';

/**
 * Postgres-backed IntentLifecycleStore. One row per intent; the ordered hops
 * live in a jsonb column. Hop assembly reuses the shared applyHop so merge
 * semantics match the in-memory store exactly.
 *
 * Real data only: query failures propagate so the API surfaces an explicit
 * error state instead of a fabricated feed.
 */
@Injectable()
export class PgIntentLifecycleStore extends IntentLifecycleStore {
  private readonly logger = new Logger(PgIntentLifecycleStore.name);

  constructor(private readonly pool: PgQueryable) {
    super();
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        intent_id     TEXT PRIMARY KEY,
        status        TEXT NOT NULL,
        sender        TEXT,
        blob_id       TEXT,
        sui_object_id TEXT,
        end_epoch     BIGINT,
        committed_blob_id TEXT,
        size          BIGINT,
        deadline      BIGINT,
        wal_cost_mist TEXT,
        hops          JSONB NOT NULL,
        created_at    BIGINT NOT NULL,
        updated_at    BIGINT NOT NULL
      )
    `);
    // Additive columns for existing deployments created before M3. Each is a
    // no-op when the column already exists, so init stays idempotent.
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS committed_blob_id TEXT`);
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS size BIGINT`);
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS deadline BIGINT`);
    await this.pool.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS wal_cost_mist TEXT`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_created_at_idx ON ${TABLE} (created_at DESC)`,
    );
    this.logger.log('intent_lifecycle table ready');
  }

  async recordHop(intentId: string, hop: IntentHop, details: HopDetails = {}): Promise<void> {
    const existing = await this.findOne(intentId);
    const record = applyHop(existing, intentId, hop, details, Date.now());

    await this.pool.query(
      `INSERT INTO ${TABLE}
         (intent_id, status, sender, blob_id, sui_object_id, end_epoch,
          committed_blob_id, size, deadline, wal_cost_mist, hops, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (intent_id) DO UPDATE SET
         status = EXCLUDED.status,
         sender = EXCLUDED.sender,
         blob_id = EXCLUDED.blob_id,
         sui_object_id = EXCLUDED.sui_object_id,
         end_epoch = EXCLUDED.end_epoch,
         committed_blob_id = EXCLUDED.committed_blob_id,
         size = EXCLUDED.size,
         deadline = EXCLUDED.deadline,
         wal_cost_mist = EXCLUDED.wal_cost_mist,
         hops = EXCLUDED.hops,
         updated_at = EXCLUDED.updated_at`,
      [
        record.intentId,
        record.status,
        record.sender ?? null,
        record.blobId ?? null,
        record.suiObjectId ?? null,
        record.endEpoch ?? null,
        record.committedBlobId ?? null,
        record.size ?? null,
        record.deadline ?? null,
        record.walCostMist ?? null,
        JSON.stringify(record.hops),
        record.createdAt,
        record.updatedAt,
      ],
    );
  }

  async getRecentIntents(limit?: number): Promise<IntentLifecycleRecord[]> {
    const sql =
      limit === undefined
        ? `SELECT * FROM ${TABLE} ORDER BY created_at DESC`
        : `SELECT * FROM ${TABLE} ORDER BY created_at DESC LIMIT $1`;
    const { rows } = await this.pool.query(sql, limit === undefined ? [] : [limit]);
    return rows.map((r) => this.mapRow(r));
  }

  async getCommitment(intentId: string): Promise<IntentCommitment | null> {
    const record = await this.findOne(intentId);
    if (
      !record ||
      record.committedBlobId === undefined ||
      record.size === undefined ||
      record.deadline === undefined
    ) {
      return null;
    }
    return {
      intentId: record.intentId,
      committedBlobId: record.committedBlobId,
      size: record.size,
      deadline: record.deadline,
      sender: record.sender,
      status: record.status,
    };
  }

  private async findOne(intentId: string): Promise<IntentLifecycleRecord | undefined> {
    const { rows } = await this.pool.query(`SELECT * FROM ${TABLE} WHERE intent_id = $1`, [
      intentId,
    ]);
    return rows.length ? this.mapRow(rows[0]) : undefined;
  }

  private mapRow(row: Record<string, unknown>): IntentLifecycleRecord {
    const rawHops = row.hops;
    const hops = (typeof rawHops === 'string' ? JSON.parse(rawHops) : rawHops) as IntentHopRecord[];
    return {
      intentId: row.intent_id as string,
      status: row.status as IntentHop,
      hops,
      sender: (row.sender as string | null) ?? undefined,
      blobId: (row.blob_id as string | null) ?? undefined,
      suiObjectId: (row.sui_object_id as string | null) ?? undefined,
      endEpoch: row.end_epoch === null ? undefined : Number(row.end_epoch),
      committedBlobId: (row.committed_blob_id as string | null) ?? undefined,
      size: row.size === null || row.size === undefined ? undefined : Number(row.size),
      deadline:
        row.deadline === null || row.deadline === undefined ? undefined : Number(row.deadline),
      walCostMist: (row.wal_cost_mist as string | null) ?? undefined,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
