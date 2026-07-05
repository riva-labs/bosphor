import { PgIntentLifecycleStore, PgQueryable } from './pg-intent-lifecycle.store';

/**
 * A minimal in-memory stand-in for a pg Pool, understanding just the three
 * query shapes PgIntentLifecycleStore issues. It lets us verify the store's
 * row<->record mapping and SQL parameter wiring behaviourally, without a real
 * Postgres. jsonb is returned pre-parsed, mirroring node-postgres.
 */
class FakePool implements PgQueryable {
  readonly rows = new Map<string, Record<string, unknown>>();
  readonly seen: string[] = [];

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    this.seen.push(text);
    const sql = text.toLowerCase();

    if (sql.includes('create table') || sql.includes('create index')) return { rows: [] };

    if (sql.startsWith('insert into')) {
      const [intentId, status, sender, blobId, suiObjectId, endEpoch, hops, createdAt, updatedAt] =
        params as [string, string, string, string, string, number, string, number, number];
      this.rows.set(intentId, {
        intent_id: intentId,
        status,
        sender,
        blob_id: blobId,
        sui_object_id: suiObjectId,
        end_epoch: endEpoch,
        hops: JSON.parse(hops),
        created_at: createdAt,
        updated_at: updatedAt,
      });
      return { rows: [] };
    }

    if (sql.includes('where intent_id')) {
      const row = this.rows.get(params[0] as string);
      return { rows: row ? [row] : [] };
    }

    if (sql.includes('order by created_at')) {
      const sorted = [...this.rows.values()].sort(
        (a, b) => (b.created_at as number) - (a.created_at as number),
      );
      const limit = params[0] as number | undefined;
      return { rows: limit === undefined ? sorted : sorted.slice(0, limit) };
    }

    throw new Error(`unexpected query: ${text}`);
  }
}

describe('PgIntentLifecycleStore', () => {
  it('creates the table on init', async () => {
    const pool = new FakePool();
    const store = new PgIntentLifecycleStore(pool);

    await store.init();

    expect(pool.seen.some((q) => q.toLowerCase().includes('create table'))).toBe(true);
  });

  it('roundtrips a recorded intent through Postgres, newest-first', async () => {
    const pool = new FakePool();
    const store = new PgIntentLifecycleStore(pool);

    await store.recordHop('0xold', 'submitted', { sender: '0xabc', timestamp: 1000 });
    await store.recordHop('0xnew', 'stored_walrus', {
      blobId: 'blob-1',
      suiObjectId: '0xobj',
      endEpoch: 42,
      txHash: '0xdig',
      timestamp: 2000,
    });

    const recent = await store.getRecentIntents();
    expect(recent.map((r) => r.intentId)).toEqual(['0xnew', '0xold']);

    const newest = recent[0];
    expect(newest.status).toBe('stored_walrus');
    expect(newest.blobId).toBe('blob-1');
    expect(newest.suiObjectId).toBe('0xobj');
    expect(newest.endEpoch).toBe(42);
    expect(newest.hops).toEqual([{ hop: 'stored_walrus', timestamp: 2000, txHash: '0xdig' }]);
  });

  it('merges progressive hops onto the same row', async () => {
    const pool = new FakePool();
    const store = new PgIntentLifecycleStore(pool);

    await store.recordHop('0xintent1', 'submitted', { timestamp: 1000 });
    await store.recordHop('0xintent1', 'received', { timestamp: 2000 });

    const [record] = await store.getRecentIntents();
    expect(record.status).toBe('received');
    expect(record.hops.map((h) => h.hop)).toEqual(['submitted', 'received']);
    expect(record.createdAt).toBe(1000);
    expect(record.updatedAt).toBe(2000);
  });

  it('honours the limit in the recent query', async () => {
    const pool = new FakePool();
    const store = new PgIntentLifecycleStore(pool);
    await store.recordHop('0xa', 'submitted', { timestamp: 1000 });
    await store.recordHop('0xb', 'submitted', { timestamp: 2000 });
    await store.recordHop('0xc', 'submitted', { timestamp: 3000 });

    const limited = await store.getRecentIntents(2);
    expect(limited.map((r) => r.intentId)).toEqual(['0xc', '0xb']);
  });
});
