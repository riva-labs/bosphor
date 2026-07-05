import { EvmLifecycleWatcher } from './evm-lifecycle.watcher';
import { EvmService } from './evm.service';
import { InMemoryIntentLifecycleStore } from '../../lifecycle/in-memory-intent-lifecycle.store';

function makeEvm(overrides: Partial<EvmService>): EvmService {
  return {
    getBlockNumber: jest.fn().mockResolvedValue(100),
    pollLifecycleEvents: jest.fn().mockResolvedValue({
      submitted: [],
      executed: [],
      newFromBlock: 100,
    }),
    ...overrides,
  } as unknown as EvmService;
}

describe('EvmLifecycleWatcher', () => {
  it('records a submitted hop from an IntentSubmitted event', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const evm = makeEvm({
      pollLifecycleEvents: jest.fn().mockResolvedValue({
        submitted: [{ intentId: '0xaa', sender: '0xsender', txHash: '0xtx1' }],
        executed: [],
        newFromBlock: 120,
      }),
    });
    const watcher = new EvmLifecycleWatcher(evm, store);

    await watcher.pollOnce();

    const [record] = await store.getRecentIntents();
    expect(record.intentId).toBe('0xaa');
    expect(record.status).toBe('submitted');
    expect(record.sender).toBe('0xsender');
    expect(record.hops[0]).toMatchObject({ hop: 'submitted', txHash: '0xtx1' });
  });

  it('records a confirmed hop from an IntentExecuted event', async () => {
    const store = new InMemoryIntentLifecycleStore();
    await store.recordHop('0xaa', 'proof_sent', { timestamp: 1000 });
    const evm = makeEvm({
      pollLifecycleEvents: jest.fn().mockResolvedValue({
        submitted: [],
        executed: [{ intentId: '0xaa', txHash: '0xtx2' }],
        newFromBlock: 120,
      }),
    });
    const watcher = new EvmLifecycleWatcher(evm, store);

    await watcher.pollOnce();

    const [record] = await store.getRecentIntents();
    expect(record.status).toBe('confirmed');
    expect(record.hops.map((h) => h.hop)).toEqual(['proof_sent', 'confirmed']);
    expect(record.hops[1]).toMatchObject({ hop: 'confirmed', txHash: '0xtx2' });
  });

  it('advances its cursor to newFromBlock across polls', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const poll = jest
      .fn()
      .mockResolvedValueOnce({ submitted: [], executed: [], newFromBlock: 150 })
      .mockResolvedValueOnce({ submitted: [], executed: [], newFromBlock: 175 });
    const evm = makeEvm({ getBlockNumber: jest.fn().mockResolvedValue(100), pollLifecycleEvents: poll });
    const watcher = new EvmLifecycleWatcher(evm, store);

    await watcher.onModuleInit(); // seeds cursor from current block (100)
    await watcher.pollOnce();
    await watcher.pollOnce();

    expect(poll).toHaveBeenNthCalledWith(1, 100);
    expect(poll).toHaveBeenNthCalledWith(2, 150);
  });

  it('does not throw when the store fails while recording a hop', async () => {
    const failing = {
      recordHop: jest.fn().mockRejectedValue(new Error('db down')),
      getRecentIntents: jest.fn(),
    } as unknown as InMemoryIntentLifecycleStore;
    const evm = makeEvm({
      pollLifecycleEvents: jest.fn().mockResolvedValue({
        submitted: [{ intentId: '0xaa', sender: '0xs', txHash: '0xt' }],
        executed: [],
        newFromBlock: 120,
      }),
    });
    const watcher = new EvmLifecycleWatcher(evm, failing);

    await expect(watcher.pollOnce()).resolves.not.toThrow();
  });
});
