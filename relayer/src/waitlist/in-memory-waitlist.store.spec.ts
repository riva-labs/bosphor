import { InMemoryWaitlistStore } from './in-memory-waitlist.store';

describe('InMemoryWaitlistStore', () => {
  it('registers a new email and reports it as created', async () => {
    const store = new InMemoryWaitlistStore();
    const res = await store.add('dev@bosphor.xyz', 'dashboard');
    expect(res.created).toBe(true);
    expect(await store.count()).toBe(1);
  });

  it('dedupes case-insensitively (same email is not created twice)', async () => {
    const store = new InMemoryWaitlistStore();
    await store.add('Dev@Bosphor.xyz');
    const res = await store.add('  dev@bosphor.xyz ');
    expect(res.created).toBe(false);
    expect(await store.count()).toBe(1);
  });

  it('lists registrations oldest-first with normalized emails', async () => {
    const store = new InMemoryWaitlistStore();
    await store.add('First@bosphor.xyz');
    await store.add('second@bosphor.xyz', 'docs');
    const list = await store.list();
    expect(list.map((e) => e.email)).toEqual(['first@bosphor.xyz', 'second@bosphor.xyz']);
    expect(list[1].source).toBe('docs');
  });
});
