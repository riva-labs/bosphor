// The watcher transitively imports SolanaService, which imports @solana/web3.js
// (a heavy dep whose transitive ESM does not transform under Jest). The real
// client is never exercised here (SolanaService is fully mocked), so stub the
// module to keep the spec pure.
jest.mock('@solana/web3.js', () => ({ Connection: class {}, PublicKey: class {} }));

import { ConfigService } from '@nestjs/config';
import { SolanaLifecycleWatcher } from './solana-lifecycle.watcher';
import { SolanaService, SolanaSubmittedEvent } from './solana.service';
import { SuiService } from '../sui/sui.service';
import { InMemoryIntentLifecycleStore } from '../../lifecycle/in-memory-intent-lifecycle.store';

function makeEvent(overrides: Partial<SolanaSubmittedEvent> = {}): SolanaSubmittedEvent {
  return {
    intentId: '0xbce25e9c',
    sender: new Uint8Array(32).fill(9), // Solana submitter pubkey
    committedBlobId: '0x86cd1161',
    size: 51,
    encodingType: 0,
    storageEpochs: 5,
    deadline: 1787126362n,
    dstEid: 40378,
    signature: 'sigAAA',
    ...overrides,
  };
}

function makeSolana(overrides: Partial<SolanaService>): SolanaService {
  return {
    isEnabled: jest.fn().mockReturnValue(true),
    getLatestSignature: jest.fn().mockResolvedValue(undefined),
    pollIntentSubmitted: jest.fn().mockResolvedValue({ events: [], newestSignature: undefined }),
    ...overrides,
  } as unknown as SolanaService;
}

const sui = { getAddress: () => '0xrelayer' } as unknown as SuiService;
const config = { get: () => undefined } as unknown as ConfigService;

describe('SolanaLifecycleWatcher', () => {
  it('records a submitted hop with the commitment from an IntentSubmitted event', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const solana = makeSolana({
      pollIntentSubmitted: jest.fn().mockResolvedValue({
        events: [makeEvent()],
        newestSignature: 'sigAAA',
      }),
    });
    const watcher = new SolanaLifecycleWatcher(solana, sui, store, config);
    await watcher.onModuleInit();

    await watcher.pollOnce();

    const commitment = await store.getCommitment('0xbce25e9c');
    expect(commitment).not.toBeNull();
    expect(commitment!.committedBlobId).toBe('0x86cd1161');
    expect(commitment!.size).toBe(51);
    // Deadline recorded in epoch ms (event carries seconds).
    expect(commitment!.deadline).toBe(1787126362000);
    // The recipient is the Sui fallback, not the Solana submitter pubkey.
    expect(commitment!.sender).toBe('0xrelayer');
    expect(commitment!.status).toBe('submitted');
  });

  it('uses SOLANA_SUI_RECIPIENT as recipient when configured', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const solana = makeSolana({
      pollIntentSubmitted: jest.fn().mockResolvedValue({
        events: [makeEvent()],
        newestSignature: 'sigAAA',
      }),
    });
    const cfg = {
      get: (k: string) => (k === 'SOLANA_SUI_RECIPIENT' ? '0xcustom' : undefined),
    } as unknown as ConfigService;
    const watcher = new SolanaLifecycleWatcher(solana, sui, store, cfg);
    await watcher.onModuleInit();

    await watcher.pollOnce();

    const commitment = await store.getCommitment('0xbce25e9c');
    expect(commitment!.sender).toBe('0xcustom');
  });

  it('advances its cursor to the newest signature across polls', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const poll = jest
      .fn()
      .mockResolvedValueOnce({ events: [], newestSignature: 'sig1' })
      .mockResolvedValueOnce({ events: [], newestSignature: 'sig2' });
    const solana = makeSolana({
      getLatestSignature: jest.fn().mockResolvedValue('sig0'),
      pollIntentSubmitted: poll,
    });
    const watcher = new SolanaLifecycleWatcher(solana, sui, store, config);
    await watcher.onModuleInit();

    await watcher.pollOnce();
    await watcher.pollOnce();

    expect(poll).toHaveBeenNthCalledWith(1, 'sig0');
    expect(poll).toHaveBeenNthCalledWith(2, 'sig1');
  });

  it('is inert when Solana support is not configured', async () => {
    const store = new InMemoryIntentLifecycleStore();
    const poll = jest.fn();
    const solana = makeSolana({
      isEnabled: jest.fn().mockReturnValue(false),
      pollIntentSubmitted: poll,
    });
    const watcher = new SolanaLifecycleWatcher(solana, sui, store, config);

    await watcher.onModuleInit();
    watcher.scheduledPoll();

    expect(poll).not.toHaveBeenCalled();
  });

  it('does not throw when the store fails while recording a hop', async () => {
    const failing = {
      recordHop: jest.fn().mockRejectedValue(new Error('db down')),
    } as unknown as InMemoryIntentLifecycleStore;
    const solana = makeSolana({
      pollIntentSubmitted: jest.fn().mockResolvedValue({
        events: [makeEvent()],
        newestSignature: 'sigAAA',
      }),
    });
    const watcher = new SolanaLifecycleWatcher(solana, sui, failing, config);
    await watcher.onModuleInit();

    await expect(watcher.pollOnce()).resolves.not.toThrow();
  });
});
