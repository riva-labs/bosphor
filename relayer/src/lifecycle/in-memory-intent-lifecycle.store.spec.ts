import { InMemoryIntentLifecycleStore } from './in-memory-intent-lifecycle.store';

describe('IntentLifecycleStore (in-memory)', () => {
  it('surfaces a newly recorded intent in the recent feed', async () => {
    const store = new InMemoryIntentLifecycleStore();

    await store.recordHop('0xintent1', 'submitted', {
      sender: '0xabc',
      timestamp: 1000,
    });

    const recent = await store.getRecentIntents();
    expect(recent).toHaveLength(1);
    expect(recent[0].intentId).toBe('0xintent1');
    expect(recent[0].status).toBe('submitted');
    expect(recent[0].sender).toBe('0xabc');
    expect(recent[0].hops).toEqual([{ hop: 'submitted', timestamp: 1000 }]);
  });

  it('captures Walrus fields when the stored_walrus hop is recorded', async () => {
    const store = new InMemoryIntentLifecycleStore();

    await store.recordHop('0xintent1', 'stored_walrus', {
      blobId: 'blob-xyz',
      suiObjectId: '0xobj',
      endEpoch: 42,
      txHash: '0xdigest',
      timestamp: 2000,
    });

    const [record] = await store.getRecentIntents();
    expect(record.blobId).toBe('blob-xyz');
    expect(record.suiObjectId).toBe('0xobj');
    expect(record.endEpoch).toBe(42);
    expect(record.hops[0]).toEqual({ hop: 'stored_walrus', timestamp: 2000, txHash: '0xdigest' });
  });

  it('merges progressive hops into one record, newest hop as status', async () => {
    const store = new InMemoryIntentLifecycleStore();

    await store.recordHop('0xintent1', 'submitted', { timestamp: 1000 });
    await store.recordHop('0xintent1', 'received', { timestamp: 2000 });
    await store.recordHop('0xintent1', 'stored_walrus', { timestamp: 3000 });

    const recent = await store.getRecentIntents();
    expect(recent).toHaveLength(1);
    expect(recent[0].status).toBe('stored_walrus');
    expect(recent[0].hops.map((h) => h.hop)).toEqual(['submitted', 'received', 'stored_walrus']);
    expect(recent[0].createdAt).toBe(1000);
    expect(recent[0].updatedAt).toBe(3000);
  });

  it('is idempotent: re-recording the same hop updates rather than duplicates', async () => {
    const store = new InMemoryIntentLifecycleStore();

    await store.recordHop('0xintent1', 'stored_walrus', { txHash: '0xfirst', timestamp: 1000 });
    await store.recordHop('0xintent1', 'stored_walrus', { txHash: '0xretry', timestamp: 1500 });

    const [record] = await store.getRecentIntents();
    expect(record.hops).toHaveLength(1);
    expect(record.hops[0]).toEqual({ hop: 'stored_walrus', timestamp: 1500, txHash: '0xretry' });
  });

  it('returns the feed newest-first and honours the limit', async () => {
    const store = new InMemoryIntentLifecycleStore();

    await store.recordHop('0xold', 'submitted', { timestamp: 1000 });
    await store.recordHop('0xmid', 'submitted', { timestamp: 2000 });
    await store.recordHop('0xnew', 'submitted', { timestamp: 3000 });

    const all = await store.getRecentIntents();
    expect(all.map((r) => r.intentId)).toEqual(['0xnew', '0xmid', '0xold']);

    const limited = await store.getRecentIntents(2);
    expect(limited.map((r) => r.intentId)).toEqual(['0xnew', '0xmid']);
  });
});
