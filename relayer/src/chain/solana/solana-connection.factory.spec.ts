import { Connection } from '@solana/web3.js';
import { createSolanaConnection } from './solana-connection.factory';

const quietLogger = { warn: jest.fn() };

function rpcReply(body: object, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: '1', ...body }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function connRefused(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
  });
}

describe('createSolanaConnection', () => {
  afterEach(() => quietLogger.warn.mockClear());

  it('builds the plain Connection for a single URL (unchanged behavior)', () => {
    const connection = createSolanaConnection('https://api.devnet.solana.com', 'confirmed');
    expect(connection).toBeInstanceOf(Connection);
    expect(connection.rpcEndpoint).toBe('https://api.devnet.solana.com');
    expect(connection.commitment).toBe('confirmed');
  });

  it('falls through a failing primary to the secondary', async () => {
    const baseFetch = jest.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://a.example')) throw connRefused();
      return rpcReply({ result: 1234 });
    });
    const onFailover = jest.fn();
    const connection = createSolanaConnection('https://a.example,https://b.example', 'confirmed', {
      baseFetch: baseFetch as typeof fetch,
      onFailover,
      logger: quietLogger,
    });

    expect(connection.rpcEndpoint).toBe('https://a.example');
    await expect(connection.getSlot()).resolves.toBe(1234);
    expect(baseFetch.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(onFailover).toHaveBeenCalledWith('solana');
  });

  it('fails over when the primary rate-limits with 429', async () => {
    const baseFetch = jest.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://a.example')
        ? new Response('Too Many Requests', { status: 429 })
        : rpcReply({ result: 99 }),
    );
    const connection = createSolanaConnection('https://a.example,https://b.example', 'confirmed', {
      baseFetch: baseFetch as typeof fetch,
      logger: quietLogger,
    });
    await expect(connection.getSlot()).resolves.toBe(99);
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a failed preflight simulation on another endpoint', async () => {
    const baseFetch = jest.fn(async () =>
      rpcReply({
        error: {
          code: -32002,
          message: 'Transaction simulation failed: Error processing Instruction 0',
        },
      }),
    );
    const onFailover = jest.fn();
    const connection = createSolanaConnection('https://a.example,https://b.example', 'confirmed', {
      baseFetch: baseFetch as typeof fetch,
      onFailover,
      logger: quietLogger,
    });
    await expect(
      connection.sendRawTransaction(Buffer.from([1, 2, 3]), { skipPreflight: false }),
    ).rejects.toThrow(/simulation failed/);
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(onFailover).not.toHaveBeenCalled();
  });
});
