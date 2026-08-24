import { StagedIntentStore, PgQueryable } from './staged-intent.store';

/**
 * A behavioural in-memory stand-in for a pg Pool that understands the query
 * shapes StagedIntentStore issues. It models rows in a Map and applies the same
 * semantics real Postgres would (ON CONFLICT with the `state='active'` guard,
 * the drain filter, SUM over rows that still hold bytes, expiry, purge), so the
 * tests assert behaviour, not SQL strings. Mirrors the FakePool pattern in
 * pg-intent-lifecycle.store.spec.ts.
 */
type Row = Record<string, unknown> & { bytes: Buffer | null };

class FakePool implements PgQueryable {
  readonly rows = new Map<string, Row>();

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const sql = text.toLowerCase();

    if (sql.includes('create table') || sql.includes('create index')) return { rows: [] };

    if (sql.startsWith('insert into')) return this.upsert(sql, params);

    if (sql.startsWith('delete from')) {
      const cutoff = params[0] as number;
      const purged: Record<string, unknown>[] = [];
      for (const [id, r] of this.rows) {
        if (['done', 'dead', 'expired'].includes(r.state as string) && (r.updated_at as number) < cutoff) {
          purged.push({ intent_id: id });
          this.rows.delete(id);
        }
      }
      return { rows: purged };
    }

    if (sql.startsWith('update')) return this.update(sql, params);

    if (sql.includes('select bytes from')) {
      const r = this.rows.get(params[0] as string);
      return { rows: r ? [{ bytes: r.bytes }] : [] };
    }

    if (sql.includes('sum(size)')) {
      let total = 0;
      for (const r of this.rows.values()) {
        if (r.bytes !== null && r.size != null) total += Number(r.size);
      }
      return { rows: [{ total }] };
    }

    if (sql.includes('next_attempt_at <=')) {
      const now = params[0] as number;
      const limit = params[1] as number;
      const due = [...this.rows.values()]
        .filter((r) => r.state === 'active' && (r.next_attempt_at as number) <= now)
        .sort((a, b) => (a.created_at as number) - (b.created_at as number))
        .slice(0, limit)
        .map((r) => this.project(r));
      return { rows: due };
    }

    if (sql.includes('where intent_id = $1')) {
      const r = this.rows.get(params[0] as string);
      return { rows: r ? [this.project(r)] : [] };
    }

    throw new Error(`unexpected query: ${text}`);
  }

  /** Metadata projection: has_bytes derived, bytes payload withheld (as the store's SELECTs do). */
  private project(r: Row): Record<string, unknown> {
    const { bytes, ...rest } = r;
    return { ...rest, has_bytes: bytes !== null };
  }

  private upsert(sql: string, params: unknown[]): { rows: Record<string, unknown>[] } {
    const id = params[0] as string;
    const existing = this.rows.get(id);
    const isBytes = sql.includes('bytes,'); // upsertBytes column list carries `bytes`

    if (existing) {
      // ON CONFLICT ... WHERE state='active' - terminal rows are untouched.
      if (existing.state !== 'active') return { rows: [] };
      if (isBytes) {
        existing.bytes = params[1] as Buffer;
        existing.blob_id = params[2] as string;
        existing.size = params[3] as number;
        existing.updated_at = params[4] as number;
      } else {
        existing.received = true;
        existing.src_eid = params[1] as number;
        existing.committed_blob_id = params[2] as string;
        existing.deadline = params[3] as number;
        existing.updated_at = params[4] as number;
      }
      return { rows: [] };
    }

    const now = isBytes ? (params[4] as number) : (params[4] as number);
    const base: Row = {
      intent_id: id,
      committed_blob_id: null,
      size: null,
      deadline: null,
      src_eid: null,
      received: false,
      bytes: null,
      blob_id: null,
      walrus_object_id: null,
      walrus_blob_id: null,
      end_epoch: null,
      store_digest: null,
      returned: false,
      state: 'active',
      attempts: 0,
      next_attempt_at: now,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    if (isBytes) {
      base.bytes = params[1] as Buffer;
      base.blob_id = params[2] as string;
      base.size = params[3] as number;
    } else {
      base.received = true;
      base.src_eid = params[1] as number;
      base.committed_blob_id = params[2] as string;
      base.deadline = params[3] as number;
    }
    this.rows.set(id, base);
    return { rows: [] };
  }

  private update(sql: string, params: unknown[]): { rows: Record<string, unknown>[] } {
    // Bulk expire has no intent_id param - it scans by deadline.
    if (sql.includes("state = 'expired'")) {
      const now = params[0] as number;
      const expired: Record<string, unknown>[] = [];
      for (const [id, r] of this.rows) {
        if (r.state === 'active' && r.deadline != null && (r.deadline as number) < now) {
          r.state = 'expired';
          r.bytes = null;
          r.updated_at = now;
          expired.push({ intent_id: id });
        }
      }
      return { rows: expired };
    }

    const r = this.rows.get(params[0] as string);
    if (!r) return { rows: [] };

    if (sql.includes('walrus_object_id = $2')) {
      r.walrus_object_id = params[1] as string;
      r.walrus_blob_id = params[2] as string;
      r.end_epoch = params[3] as number;
      r.updated_at = params[4] as number;
    } else if (sql.includes('store_digest = $2')) {
      r.store_digest = params[1] as string;
      r.updated_at = params[2] as number;
    } else if (sql.includes('returned = true')) {
      r.returned = true;
      r.updated_at = params[1] as number;
    } else if (sql.includes("state = 'done'")) {
      r.state = 'done';
      r.bytes = null;
      r.updated_at = params[1] as number;
    } else if (sql.includes("state = 'dead'")) {
      r.state = 'dead';
      r.bytes = null;
      r.last_error = params[1] as string;
      r.updated_at = params[2] as number;
    } else if (sql.includes('attempts = $2')) {
      r.attempts = params[1] as number;
      r.next_attempt_at = params[2] as number;
      r.last_error = params[3] as string;
      r.updated_at = params[4] as number;
    } else if (sql.includes('bytes = null')) {
      r.bytes = null;
      r.updated_at = params[1] as number;
    } else {
      throw new Error(`unexpected update: ${sql}`);
    }
    return { rows: [] };
  }
}

const RX = { srcEid: 40161, committedBlobId: '0x' + 'ab'.repeat(32), deadline: 2_000_000_000_000 };

describe('StagedIntentStore', () => {
  let clock = 1_000;
  beforeEach(() => {
    clock = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  const bytes = (s: string) => Buffer.from(s);

  it('creates the table and drain index on init', async () => {
    const pool = new FakePool();
    const seen: string[] = [];
    const spy = jest.spyOn(pool, 'query').mockImplementation(async (t: string) => {
      seen.push(t.toLowerCase());
      return { rows: [] };
    });
    await new StagedIntentStore(pool).init();
    expect(seen.some((q) => q.includes('create table'))).toBe(true);
    expect(seen.some((q) => q.includes('create index') && q.includes('drain_idx'))).toBe(true);
    spy.mockRestore();
  });

  it('buffers bytes as a new active row, then merges the received event onto it', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0xa', { bytes: bytes('hello'), blobId: 'blob-a', size: 5 });
    let row = await store.get('0xa');
    expect(row?.state).toBe('active');
    expect(row?.hasBytes).toBe(true);
    expect(row?.blobId).toBe('blob-a');
    expect(row?.size).toBe(5);
    expect(row?.received).toBe(false);

    await store.markReceived('0xa', RX);
    row = await store.get('0xa');
    expect(row?.received).toBe(true);
    expect(row?.srcEid).toBe(RX.srcEid);
    expect(row?.deadline).toBe(RX.deadline);
    expect(row?.hasBytes).toBe(true); // bytes not wiped by the event
  });

  it('is order-independent: received event before bytes still ends up ready-shaped', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.markReceived('0xb', RX);
    let row = await store.get('0xb');
    expect(row?.received).toBe(true);
    expect(row?.hasBytes).toBe(false);

    await store.upsertBytes('0xb', { bytes: bytes('data'), blobId: 'blob-b', size: 4 });
    row = await store.get('0xb');
    expect(row?.received).toBe(true);
    expect(row?.hasBytes).toBe(true);
    expect(row?.blobId).toBe('blob-b');
  });

  it('is terminal-sticky: a late event cannot resurrect a done intent', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0xc', { bytes: bytes('x'), blobId: 'blob-c', size: 1 });
    await store.markDone('0xc');

    await store.markReceived('0xc', RX); // backfilled event
    const row = await store.get('0xc');
    expect(row?.state).toBe('done');
    expect(row?.received).toBe(false); // guard held; no resurrection
  });

  it('drains only active, due rows, oldest first, without the bytes payload', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    clock = 1000;
    await store.upsertBytes('0xold', { bytes: bytes('a'), blobId: 'b1', size: 1 });
    clock = 2000;
    await store.upsertBytes('0xnew', { bytes: bytes('b'), blobId: 'b2', size: 1 });
    clock = 3000;
    await store.upsertBytes('0xdone', { bytes: bytes('c'), blobId: 'b3', size: 1 });
    await store.markDone('0xdone'); // terminal -> excluded
    clock = 4000;
    await store.upsertBytes('0xfuture', { bytes: bytes('d'), blobId: 'b4', size: 1 });
    await store.reschedule('0xfuture', 1, 9_999_999, 'backoff'); // not due yet

    const due = await store.drainDue(5000, 10);
    expect(due.map((r) => r.intentId)).toEqual(['0xold', '0xnew']);
    expect((due[0] as unknown as Record<string, unknown>).bytes).toBeUndefined();
    expect(due[0].hasBytes).toBe(true);

    const limited = await store.drainDue(5000, 1);
    expect(limited.map((r) => r.intentId)).toEqual(['0xold']);
  });

  it('persists per-step results for idempotent retry and fetches/frees bytes', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0xd', { bytes: bytes('payload'), blobId: 'blob-d', size: 7 });
    expect((await store.fetchBytes('0xd'))?.toString()).toBe('payload');

    await store.persistUpload('0xd', { walrusObjectId: '0xobj', walrusBlobId: 'wblob', endEpoch: 42 });
    await store.persistStore('0xd', '0xdigest');
    await store.markReturned('0xd');
    const row = await store.get('0xd');
    expect(row?.walrusObjectId).toBe('0xobj');
    expect(row?.endEpoch).toBe(42);
    expect(row?.storeDigest).toBe('0xdigest');
    expect(row?.returned).toBe(true);

    await store.freeBytes('0xd');
    expect(await store.fetchBytes('0xd')).toBeUndefined();
  });

  it('sums staged bytes by size, counting only rows that still hold bytes', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0x1', { bytes: bytes('aa'), blobId: 'b1', size: 100 });
    await store.upsertBytes('0x2', { bytes: bytes('bb'), blobId: 'b2', size: 250 });
    expect(await store.stagedBytesTotal()).toBe(350);

    await store.markDone('0x1'); // frees bytes -> drops out of the total
    expect(await store.stagedBytesTotal()).toBe(250);
  });

  it('expires past-deadline active rows and frees their bytes', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.markReceived('0xexp', { ...RX, deadline: 1500 });
    await store.upsertBytes('0xexp', { bytes: bytes('z'), blobId: 'b', size: 1 });
    await store.markReceived('0xlive', { ...RX, deadline: 9000 });
    await store.upsertBytes('0xlive', { bytes: bytes('z'), blobId: 'b', size: 1 });

    const expired = await store.expireDue(2000);
    expect(expired).toBe(1);
    expect((await store.get('0xexp'))?.state).toBe('expired');
    expect((await store.get('0xexp'))?.hasBytes).toBe(false);
    expect((await store.get('0xlive'))?.state).toBe('active');
  });

  it('purges terminal rows older than the cutoff, keeps active ones', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    clock = 1000;
    await store.upsertBytes('0xgone', { bytes: bytes('a'), blobId: 'b', size: 1 });
    await store.markDead('0xgone', 'terminal');
    clock = 5000;
    await store.upsertBytes('0xkeep', { bytes: bytes('b'), blobId: 'b', size: 1 });

    const purged = await store.purgeTerminal(3000);
    expect(purged).toBe(1);
    expect(await store.get('0xgone')).toBeUndefined();
    expect((await store.get('0xkeep'))?.state).toBe('active');
  });
});
