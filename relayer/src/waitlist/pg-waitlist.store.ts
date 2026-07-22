import { Injectable, Logger } from '@nestjs/common';
import { normalizeEmail } from './email';
import { WaitlistStore } from './waitlist.store';
import { WaitlistAddResult, WaitlistEntry } from './waitlist.types';

/**
 * The slice of a node-postgres Pool this store needs. Narrowed to a single
 * method so the store is trivially testable with a fake and does not couple to
 * the full pg surface. (Mirrors the lifecycle store's PgQueryable.)
 */
export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const TABLE = 'waitlist';

/**
 * Postgres-backed WaitlistStore. One row per unique (normalized) email. Dedupe
 * is enforced by the primary key + ON CONFLICT DO NOTHING, so a duplicate signup
 * is a no-op that returns `{ created: false }`.
 *
 * Real data only: query failures propagate so the API surfaces an explicit
 * error state instead of a fabricated success.
 */
@Injectable()
export class PgWaitlistStore extends WaitlistStore {
  private readonly logger = new Logger(PgWaitlistStore.name);

  constructor(private readonly pool: PgQueryable) {
    super();
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        email      TEXT PRIMARY KEY,
        source     TEXT,
        created_at BIGINT NOT NULL
      )
    `);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS ${TABLE}_created_at_idx ON ${TABLE} (created_at ASC)`,
    );
    this.logger.log('waitlist table ready');
  }

  async add(email: string, source?: string): Promise<WaitlistAddResult> {
    const key = normalizeEmail(email);
    const { rows } = await this.pool.query(
      `INSERT INTO ${TABLE} (email, source, created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING email`,
      [key, source ?? null, Date.now()],
    );
    return { created: rows.length > 0 };
  }

  async list(): Promise<WaitlistEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT email, source, created_at FROM ${TABLE} ORDER BY created_at ASC`,
    );
    return rows.map((r) => ({
      email: r.email as string,
      source: (r.source as string | null) ?? undefined,
      createdAt: Number(r.created_at),
    }));
  }

  async count(): Promise<number> {
    const { rows } = await this.pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
    return Number(rows[0]?.n ?? 0);
  }
}
