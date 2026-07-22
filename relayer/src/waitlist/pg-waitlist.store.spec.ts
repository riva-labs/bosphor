import { PgQueryable, PgWaitlistStore } from './pg-waitlist.store';

/** Minimal fake Pool that records the last query and returns a scripted result. */
function fakePool(rows: Record<string, unknown>[] = []): PgQueryable & {
  calls: { text: string; params?: unknown[] }[];
} {
  const calls: { text: string; params?: unknown[] }[] = [];
  return {
    calls,
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      return { rows };
    },
  };
}

describe('PgWaitlistStore', () => {
  it('inserts with ON CONFLICT DO NOTHING and normalizes the email', async () => {
    const pool = fakePool([{ email: 'dev@bosphor.xyz' }]);
    const store = new PgWaitlistStore(pool);

    const res = await store.add('  Dev@Bosphor.XYZ ', 'dashboard');

    expect(res.created).toBe(true);
    const insert = pool.calls.at(-1)!;
    expect(insert.text).toMatch(/ON CONFLICT \(email\) DO NOTHING/);
    expect(insert.params?.[0]).toBe('dev@bosphor.xyz');
    expect(insert.params?.[1]).toBe('dashboard');
  });

  it('reports created=false when the insert conflicts (no rows returned)', async () => {
    const store = new PgWaitlistStore(fakePool([]));
    expect((await store.add('dup@bosphor.xyz')).created).toBe(false);
  });

  it('maps count from the aggregate query', async () => {
    const store = new PgWaitlistStore(fakePool([{ n: 7 }]));
    expect(await store.count()).toBe(7);
  });

  it('propagates store failures instead of fabricating success', async () => {
    const failing: PgQueryable = {
      query: jest.fn().mockRejectedValue(new Error('db down')),
    };
    const store = new PgWaitlistStore(failing);
    await expect(store.add('dev@bosphor.xyz')).rejects.toThrow('db down');
  });
});
