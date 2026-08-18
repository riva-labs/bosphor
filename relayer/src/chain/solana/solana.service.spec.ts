// Mock the heavy @solana/web3.js client. `mockConn` is the single Connection
// instance the service constructs; tests drive its RPC methods directly.
const mockConn = {
  getSignaturesForAddress: jest.fn(),
  getTransaction: jest.fn(),
};
jest.mock('@solana/web3.js', () => ({
  Connection: jest.fn(() => mockConn),
  PublicKey: jest.fn((v: string) => ({ toString: () => v })),
}));

import { ConfigService } from '@nestjs/config';
import { SolanaService } from './solana.service';

const REAL_EVENT_B64 =
  'zmTnjfUeUGO84l6cm5u+48BscfIl453dwaxkjEDMDjv5mWS5wRAZhZq1X5nEcnFiea0SftzEbX5ZUSr' +
  'CbxjgcfVrTNOBGvt5AgAAAAAAAACGzRFhKK+Z0pYAHvqqUac9d+x+Atua+DThzQT0IcCflTMAAAAABQAA' +
  'AFpihWoAAAAAup0AAOavAaaiQ2PQE1WnBgw9SN7hiIzcwde5rhI56gak1eO5AwAAAAAAAAA=';

function makeConfig(vals: Record<string, string>): ConfigService {
  return { get: (k: string) => vals[k] } as unknown as ConfigService;
}

function enabledService(): SolanaService {
  const s = new SolanaService(
    makeConfig({ SOLANA_RPC_URL: 'http://rpc', SOLANA_PROGRAM_ID: 'ProgramId' }),
  );
  s.onModuleInit();
  return s;
}

describe('SolanaService', () => {
  beforeEach(() => {
    mockConn.getSignaturesForAddress.mockReset();
    mockConn.getTransaction.mockReset();
  });

  it('is disabled when RPC url or program id is missing', () => {
    const s = new SolanaService(makeConfig({}));
    s.onModuleInit();
    expect(s.isEnabled()).toBe(false);
  });

  it('is enabled when both RPC url and program id are set', () => {
    expect(enabledService().isEnabled()).toBe(true);
  });

  it('decodes events, orders them oldest-first, and advances the cursor', async () => {
    const s = enabledService();
    // getSignaturesForAddress returns newest-first.
    mockConn.getSignaturesForAddress.mockResolvedValue([
      { signature: 'sig2', err: null },
      { signature: 'sig1', err: null },
    ]);
    mockConn.getTransaction.mockResolvedValue({
      meta: { logMessages: [`Program data: ${REAL_EVENT_B64}`] },
    });

    const { events, newestSignature } = await s.pollIntentSubmitted('sig0');

    expect(mockConn.getSignaturesForAddress).toHaveBeenCalledWith(
      expect.anything(),
      { until: 'sig0', limit: 100 },
      'confirmed',
    );
    expect(newestSignature).toBe('sig2');
    // Reversed to oldest-first for in-order lifecycle recording.
    expect(events.map((e) => e.signature)).toEqual(['sig1', 'sig2']);
    expect(events[0].intentId).toBe(
      '0xbce25e9c9b9bbee3c06c71f225e39dddc1ac648c40cc0e3bf99964b9c1101985',
    );
  });

  it('skips errored transactions', async () => {
    const s = enabledService();
    mockConn.getSignaturesForAddress.mockResolvedValue([
      { signature: 'sigBad', err: { InstructionError: [] } },
    ]);

    const { events, newestSignature } = await s.pollIntentSubmitted();

    expect(mockConn.getTransaction).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    // Cursor still advances past the errored signature so it is not re-fetched.
    expect(newestSignature).toBe('sigBad');
  });

  it('returns the prior cursor unchanged when there is nothing new', async () => {
    const s = enabledService();
    mockConn.getSignaturesForAddress.mockResolvedValue([]);

    const { events, newestSignature } = await s.pollIntentSubmitted('sigPrev');

    expect(events).toEqual([]);
    expect(newestSignature).toBe('sigPrev');
  });

  it('swallows a transient RPC error and keeps the prior cursor', async () => {
    const s = enabledService();
    mockConn.getSignaturesForAddress.mockRejectedValue(
      Object.assign(new Error('rate limited'), { code: -32020 }),
    );

    // Must not reject: a rejection here would become an unhandled rejection and
    // crash the relayer (the public devnet RPC is rate-limited and lags).
    const res = await s.pollIntentSubmitted('sigPrev');
    expect(res).toEqual({ events: [], newestSignature: 'sigPrev' });
  });

  it('does not advance the cursor when a per-tx fetch fails mid-batch', async () => {
    const s = enabledService();
    mockConn.getSignaturesForAddress.mockResolvedValue([{ signature: 'sigNew', err: null }]);
    mockConn.getTransaction.mockRejectedValue(new Error('tx not available'));

    const res = await s.pollIntentSubmitted('sigOld');
    expect(res).toEqual({ events: [], newestSignature: 'sigOld' });
  });

  it('getLatestSignature returns undefined on a transient RPC error', async () => {
    const s = enabledService();
    mockConn.getSignaturesForAddress.mockRejectedValue(new Error('boom'));
    expect(await s.getLatestSignature()).toBeUndefined();
  });

  it('getLatestSignature returns the newest signature', async () => {
    const s = enabledService();
    mockConn.getSignaturesForAddress.mockResolvedValue([{ signature: 'sigHead', err: null }]);
    expect(await s.getLatestSignature()).toBe('sigHead');
  });

  it('poll is a no-op when disabled', async () => {
    const s = new SolanaService(makeConfig({}));
    s.onModuleInit();
    const res = await s.pollIntentSubmitted('sig0');
    expect(res).toEqual({ events: [], newestSignature: 'sig0' });
    expect(mockConn.getSignaturesForAddress).not.toHaveBeenCalled();
  });
});
