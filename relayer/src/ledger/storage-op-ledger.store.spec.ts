import { PgQueryable, StorageOpLedgerStore } from './storage-op-ledger.store';
import { StorageOpEntry } from './storage-op-ledger.types';

/**
 * Behavioural in-memory stand-in for a pg Pool that understands the ledger's
 * query shapes: INSERT ... ON CONFLICT (intent_id) DO NOTHING RETURNING (the
 * exactly-once write), the stored_at window select, and the by-id select. BIGINT
 * columns come back as strings, as node-postgres returns them. Mirrors the
 * FakePool pattern in staged-intent.store.spec.ts.
 */
class FakePool implements PgQueryable {
  readonly rows = new Map<string, Record<string, unknown>>();
  inserts = 0;

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const sql = text.trim().toLowerCase();
    if (sql.startsWith('create')) return { rows: [] };

    if (sql.startsWith('insert into storage_op_ledger')) {
      this.inserts++;
      const id = params[0] as string;
      if (this.rows.has(id)) return { rows: [] }; // ON CONFLICT DO NOTHING
      const big = (v: unknown) => (v === null ? null : String(v));
      this.rows.set(id, {
        intent_id: id,
        src_eid: params[1],
        sender: params[2],
        size: big(params[3]),
        blob_id: params[4],
        walrus_blob_id: params[5],
        walrus_object_id: params[6],
        end_epoch: big(params[7]),
        app_id: params[8],
        network: params[9],
        store_digest: params[10],
        created_at: big(params[11]),
        stored_at: big(params[12]),
        recorded_at: big(params[13]),
      });
      return { rows: [{ intent_id: id }] };
    }

    if (sql.includes('stored_at >= $1 and stored_at < $2')) {
      const [since, until] = params as number[];
      const rows = [...this.rows.values()]
        .filter((r) => Number(r.stored_at) >= since && Number(r.stored_at) < until)
        .sort((a, b) => Number(a.stored_at) - Number(b.stored_at));
      return { rows };
    }

    if (sql.includes('where intent_id = $1')) {
      const r = this.rows.get(params[0] as string);
      return { rows: r ? [r] : [] };
    }

    throw new Error(`unexpected query: ${text}`);
  }
}

function entry(o: Partial<StorageOpEntry> = {}): StorageOpEntry {
  return {
    intentId: '0xa',
    srcEid: 40161,
    sender: '0xsender',
    size: 1024,
    blobId: '0x' + 'ab'.repeat(32),
    walrusBlobId: 'q6urq6s',
    walrusObjectId: '0xobj',
    endEpoch: 42,
    appId: 'my-dapp',
    network: 'testnet',
    storeDigest: '0xdigest',
    createdAt: 1_000,
    storedAt: 2_000,
    ...o,
  };
}

describe('StorageOpLedgerStore', () => {
  it('creates the table and the stored_at index on init', async () => {
    const pool = new FakePool();
    const seen: string[] = [];
    jest.spyOn(pool, 'query').mockImplementation(async (t: string) => {
      seen.push(t.toLowerCase());
      return { rows: [] };
    });
    await new StorageOpLedgerStore(pool).init();
    expect(seen.some((q) => q.includes('create table if not exists storage_op_ledger'))).toBe(true);
    expect(seen.some((q) => q.includes('stored_at_idx'))).toBe(true);
  });

  it('records a completed op and reads it back with numeric fields', async () => {
    const store = new StorageOpLedgerStore(new FakePool());
    expect(await store.record(entry())).toBe(true);
    expect(await store.get('0xa')).toEqual(entry());
  });

  it('is exactly-once: a repeated record is a no-op that reports false', async () => {
    const pool = new FakePool();
    const store = new StorageOpLedgerStore(pool);
    expect(await store.record(entry())).toBe(true);
    // A retry (return-leg retry, backfill sweep) carrying different values never
    // overwrites the first write.
    expect(await store.record(entry({ size: 9, appId: null }))).toBe(false);
    expect(await store.record(entry())).toBe(false);
    expect(pool.inserts).toBe(3);
    expect(pool.rows.size).toBe(1);
    expect((await store.get('0xa'))?.size).toBe(1024);
    expect((await store.get('0xa'))?.appId).toBe('my-dapp');
  });

  it('keeps a missing app id as null', async () => {
    const store = new StorageOpLedgerStore(new FakePool());
    await store.record(entry({ appId: null }));
    expect((await store.get('0xa'))?.appId).toBeNull();
  });

  it('lists ops stored inside a half-open window, oldest first', async () => {
    const store = new StorageOpLedgerStore(new FakePool());
    await store.record(entry({ intentId: '0x3', storedAt: 3_000 }));
    await store.record(entry({ intentId: '0x1', storedAt: 1_000 }));
    await store.record(entry({ intentId: '0x2', storedAt: 2_000 }));
    const got = await store.listStoredBetween(1_000, 3_000);
    expect(got.map((e) => e.intentId)).toEqual(['0x1', '0x2']);
  });
});
