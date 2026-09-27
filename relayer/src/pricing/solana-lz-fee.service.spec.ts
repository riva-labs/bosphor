import { ConfigService } from '@nestjs/config';
import {
  SOLANA_LZ_FEE_RETRY_AFTER_SECONDS,
  SolanaLzFeeService,
  SolanaLzFeeUnavailableError,
} from './solana-lz-fee.service';
import type { SolanaLzFeeDeps, SolanaLzFeePath } from './solana-lz-fee';

const ENABLED: Record<string, unknown> = {
  SOLANA_RPC_URL: 'https://api.devnet.solana.com',
  SOLANA_PROGRAM_ID: '7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF',
  SOLANA_LZ_ENDPOINT_PROGRAM: '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
  SOLANA_LZ_ULN_PROGRAM: '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH',
  SOLANA_LZ_SUI_PEER: '0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5',
  SOLANA_LZ_OPTIONS: '0x00030100110100000000000000000000000000030d40',
  SOLANA_LZ_FEE_CACHE_MS: 30_000,
  SOLANA_SRC_EID: 40168,
  SUI_EID: 40378,
};

function config(values: Record<string, unknown>): ConfigService {
  return { get: (k: string, def?: unknown) => (k in values ? values[k] : def) } as ConfigService;
}

function setup(values: Record<string, unknown> = ENABLED) {
  let now = 1_000_000;
  const quote = jest.fn<Promise<bigint>, [SolanaLzFeeDeps, SolanaLzFeePath]>();
  const loadDeps = jest.fn(() => ({ connection: {}, web3: {}, lz: {} }) as SolanaLzFeeDeps);
  const svc = new SolanaLzFeeService(config(values), {
    loadDeps,
    quote,
    now: () => now,
  });
  return { svc, quote, loadDeps, advance: (ms: number) => (now += ms), now: () => now };
}

describe('SolanaLzFeeService', () => {
  it('is disabled unless Solana RPC, program and Sui peer are configured', () => {
    expect(setup().svc.isEnabled()).toBe(true);
    for (const key of ['SOLANA_RPC_URL', 'SOLANA_PROGRAM_ID', 'SOLANA_LZ_SUI_PEER']) {
      const { svc } = setup({ ...ENABLED, [key]: '' });
      expect(svc.isEnabled()).toBe(false);
    }
  });

  it('throws when quoting while disabled', async () => {
    const { svc } = setup({ ...ENABLED, SOLANA_LZ_SUI_PEER: '' });
    await expect(svc.quote()).rejects.toThrow(/not enabled/);
  });

  it('quotes the configured pathway and reports its eids and age', async () => {
    const { svc, quote, now } = setup();
    quote.mockResolvedValue(5_911_260n);
    const q = await svc.quote();
    expect(q).toEqual({
      nativeFee: 5_911_260n,
      srcEid: 40168,
      dstEid: 40378,
      quotedAtMs: now(),
      maxAgeMs: 30_000,
    });
    expect(quote.mock.calls[0][1]).toEqual({
      programId: ENABLED.SOLANA_PROGRAM_ID,
      endpointProgram: ENABLED.SOLANA_LZ_ENDPOINT_PROGRAM,
      ulnProgram: ENABLED.SOLANA_LZ_ULN_PROGRAM,
      dstEid: 40378,
      receiver: ENABLED.SOLANA_LZ_SUI_PEER,
      options: ENABLED.SOLANA_LZ_OPTIONS,
    });
  });

  it('serves the cached fee within the TTL and re-quotes after it', async () => {
    const { svc, quote, advance, loadDeps } = setup();
    quote.mockResolvedValueOnce(100n).mockResolvedValueOnce(200n);
    expect((await svc.quote()).nativeFee).toBe(100n);
    advance(29_999);
    expect((await svc.quote()).nativeFee).toBe(100n);
    expect(quote).toHaveBeenCalledTimes(1);
    advance(1);
    expect((await svc.quote()).nativeFee).toBe(200n);
    expect(quote).toHaveBeenCalledTimes(2);
    expect(loadDeps).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight simulation between concurrent callers', async () => {
    const { svc, quote } = setup();
    let release!: (v: bigint) => void;
    quote.mockReturnValue(new Promise<bigint>((r) => (release = r)));
    const a = svc.quote();
    const b = svc.quote();
    release(7n);
    expect((await a).nativeFee).toBe(7n);
    expect((await b).nativeFee).toBe(7n);
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('never caches or serves a stale value on failure: the next call retries', async () => {
    const { svc, quote, advance } = setup();
    quote.mockResolvedValueOnce(100n);
    await svc.quote();
    advance(30_000);
    quote.mockRejectedValueOnce(new Error('rpc down'));
    await expect(svc.quote()).rejects.toThrow('rpc down');
    advance(SOLANA_LZ_FEE_RETRY_AFTER_SECONDS * 1000);
    quote.mockResolvedValueOnce(300n);
    expect((await svc.quote()).nativeFee).toBe(300n);
  });

  it('remembers a failure for the retry window instead of re-simulating on every call', async () => {
    const { svc, quote, advance } = setup();
    quote.mockRejectedValue(new Error('rpc down'));
    const first = await svc.quote().catch((e: unknown) => e);
    expect(first).toBeInstanceOf(SolanaLzFeeUnavailableError);
    expect((first as SolanaLzFeeUnavailableError).retryAfterSeconds).toBe(
      SOLANA_LZ_FEE_RETRY_AFTER_SECONDS,
    );

    advance(2_000);
    const again = (await svc.quote().catch((e: unknown) => e)) as SolanaLzFeeUnavailableError;
    expect(again).toBeInstanceOf(SolanaLzFeeUnavailableError);
    expect(again.message).toMatch(/rpc down/);
    expect(again.retryAfterSeconds).toBe(SOLANA_LZ_FEE_RETRY_AFTER_SECONDS - 2);
    expect(quote).toHaveBeenCalledTimes(1);

    advance(3_000);
    await expect(svc.quote()).rejects.toThrow('rpc down');
    expect(quote).toHaveBeenCalledTimes(2);
  });
});
