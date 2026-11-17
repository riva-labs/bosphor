import { ethers } from 'ethers';
import { createEvmProvider, FailoverJsonRpcProvider } from './failover-provider';

const CHAIN_ID = 11155111;
const OPTIONS = { staticNetwork: true, polling: true } as const;
const quietLogger = { warn: jest.fn() };

type Payload = ethers.JsonRpcPayload | ethers.JsonRpcPayload[];

/** Build a JSON-RPC reply per request. Error replies share the array, as on the wire. */
function respond(
  payload: Payload,
  body: (p: ethers.JsonRpcPayload) => object,
): ethers.JsonRpcResult[] {
  const list = Array.isArray(payload) ? payload : [payload];
  return list.map((p) => ({
    jsonrpc: '2.0',
    id: p.id,
    ...body(p),
  })) as unknown as ethers.JsonRpcResult[];
}

function dnsFailure(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND a.example'), { code: 'ENOTFOUND' }),
  });
}

/** Two-endpoint provider whose per-endpoint transports are jest mocks. */
function makeProvider(onFailover = jest.fn()) {
  const provider = new FailoverJsonRpcProvider(
    ['https://a.example', 'https://b.example'],
    CHAIN_ID,
    OPTIONS,
    { onFailover, logger: quietLogger },
  );
  const endpoints = (provider as unknown as { endpoints: ethers.JsonRpcProvider[] }).endpoints;
  const primary = jest.spyOn(endpoints[0], '_send');
  const secondary = jest.spyOn(endpoints[1], '_send');
  return { provider, primary, secondary, onFailover };
}

describe('createEvmProvider', () => {
  it('builds a plain JsonRpcProvider for a single URL (unchanged behavior)', () => {
    const provider = createEvmProvider('https://rpc.example/v3/KEY', CHAIN_ID, OPTIONS);
    expect(provider).toBeInstanceOf(ethers.JsonRpcProvider);
    expect(provider).not.toBeInstanceOf(FailoverJsonRpcProvider);
    expect(provider._getConnection().url).toBe('https://rpc.example/v3/KEY');
    provider.destroy();
  });

  it('builds a failover provider for a comma-separated list, primary first', () => {
    const provider = createEvmProvider('https://a.example, https://b.example', CHAIN_ID, OPTIONS);
    expect(provider).toBeInstanceOf(FailoverJsonRpcProvider);
    expect((provider as FailoverJsonRpcProvider).failover.urls).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    provider.destroy();
  });
});

describe('FailoverJsonRpcProvider', () => {
  afterEach(() => quietLogger.warn.mockClear());

  it('falls through a failing primary to the secondary', async () => {
    const { provider, primary, secondary, onFailover } = makeProvider();
    primary.mockRejectedValue(dnsFailure());
    secondary.mockImplementation(async (payload) => respond(payload, () => ({ result: '0x10' })));

    await expect(provider.getBlockNumber()).resolves.toBe(16);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(secondary).toHaveBeenCalledTimes(1);
    expect(onFailover).toHaveBeenCalledWith('evm');
    provider.destroy();
  });

  it('fails over when the primary has pruned the requested log range', async () => {
    const { provider, primary, secondary } = makeProvider();
    primary.mockImplementation(async (payload) =>
      respond(payload, () => ({ error: { code: -32000, message: 'block range is too large' } })),
    );
    secondary.mockImplementation(async (payload) => respond(payload, () => ({ result: [] })));

    await expect(provider.getLogs({ fromBlock: 1, toBlock: 100_000 })).resolves.toEqual([]);
    expect(secondary).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it('re-sends the same signed transaction bytes to the secondary', async () => {
    const { provider, primary, secondary } = makeProvider();
    const raw = '0x02f8';
    primary.mockRejectedValue(Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }));
    secondary.mockImplementation(async (payload) =>
      respond(payload, () => ({ result: '0x' + 'ab'.repeat(32) })),
    );

    await provider.send('eth_sendRawTransaction', [raw]);
    const sentPrimary = primary.mock.calls[0][0] as ethers.JsonRpcPayload;
    const sentSecondary = secondary.mock.calls[0][0] as ethers.JsonRpcPayload;
    expect(sentSecondary.params).toEqual(sentPrimary.params);
    expect(sentSecondary.params).toEqual([raw]);
    provider.destroy();
  });

  it('does not retry a contract revert on another endpoint', async () => {
    const { provider, primary, secondary, onFailover } = makeProvider();
    primary.mockImplementation(async (payload) =>
      respond(payload, () => ({
        error: { code: 3, message: 'execution reverted', data: '0x08c379a0' },
      })),
    );

    await expect(provider.call({ to: '0x' + '22'.repeat(20), data: '0x' })).rejects.toMatchObject({
      code: 'CALL_EXCEPTION',
    });
    expect(secondary).not.toHaveBeenCalled();
    expect(onFailover).not.toHaveBeenCalled();
    provider.destroy();
  });
});
