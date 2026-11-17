import {
  createFailoverFetch,
  isRetryableJsonRpcError,
  isTransportFailure,
  parseRpcUrls,
  rebaseUrl,
  RpcFailover,
} from './rpc-failover';

const quietLogger = { warn: jest.fn() };

function fetchFailed(cause: string): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error(`getaddrinfo ${cause} rpc.example`), { code: cause }),
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('parseRpcUrls', () => {
  it('splits, trims and drops empties', () => {
    expect(parseRpcUrls(' https://a.example , https://b.example,,')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('keeps a single URL as one entry', () => {
    expect(parseRpcUrls('https://a.example/v3/KEY')).toEqual(['https://a.example/v3/KEY']);
  });

  it('returns no URLs for an unset value', () => {
    expect(parseRpcUrls(undefined)).toEqual([]);
    expect(parseRpcUrls('')).toEqual([]);
  });
});

describe('isTransportFailure', () => {
  it.each([
    fetchFailed('ENOTFOUND'),
    fetchFailed('EAI_AGAIN'),
    Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }),
    Object.assign(new Error('server response 503'), { code: 'SERVER_ERROR' }),
    new Error('429 Too Many Requests'),
  ])('fails over on %p', (err) => {
    expect(isTransportFailure(err)).toBe(true);
  });

  it.each([
    Object.assign(new Error('execution reverted: AlreadyExecuted'), { code: 'CALL_EXCEPTION' }),
    new Error('MoveAbort(MoveLocation { module: walrus_executor }, 7)'),
    Object.assign(new Error('nonce too low'), { code: 'NONCE_EXPIRED' }),
    new Error('This operation was aborted'),
  ])('does not fail over on %p', (err) => {
    expect(isTransportFailure(err)).toBe(false);
  });
});

describe('isRetryableJsonRpcError', () => {
  it('retries pruned history and range caps', () => {
    expect(isRetryableJsonRpcError({ code: -32000, message: 'block range is too large' })).toBe(
      true,
    );
    expect(
      isRetryableJsonRpcError({ code: -32701, message: 'History has been pruned for this block' }),
    ).toBe(true);
    expect(isRetryableJsonRpcError({ code: -32005, message: 'limit exceeded' })).toBe(true);
  });

  it('does not retry reverts or bad params', () => {
    expect(isRetryableJsonRpcError({ code: 3, message: 'execution reverted' })).toBe(false);
    expect(isRetryableJsonRpcError({ code: -32602, message: 'invalid argument 0' })).toBe(false);
    expect(
      isRetryableJsonRpcError({
        code: -32002,
        message: 'Transaction simulation failed: custom program error: 0x1770',
      }),
    ).toBe(false);
  });
});

describe('RpcFailover', () => {
  beforeEach(() => quietLogger.warn.mockClear());

  it('falls through a failing primary to the secondary', async () => {
    const onFailover = jest.fn();
    const pool = new RpcFailover('evm', ['https://a.example', 'https://b.example'], {
      onFailover,
      logger: quietLogger,
    });
    const fn = jest.fn(async (i: number) => {
      if (i === 0) throw fetchFailed('ENOTFOUND');
      return 'ok';
    });

    await expect(pool.run('eth_blockNumber', fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onFailover).toHaveBeenCalledWith('evm');
    expect(quietLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/a\.example failed on eth_blockNumber .*failing over to b\.example/),
    );
    expect(pool.activeIndex).toBe(1);
  });

  it('stays on the fallback, then retries the primary after the cooldown', async () => {
    let now = 0;
    const pool = new RpcFailover('sui', ['https://a.example', 'https://b.example'], {
      logger: quietLogger,
      primaryRetryMs: 1000,
      now: () => now,
    });
    let primaryDown = true;
    const calls: number[] = [];
    const fn = async (i: number) => {
      calls.push(i);
      if (i === 0 && primaryDown) throw fetchFailed('ECONNREFUSED');
      return i;
    };

    await pool.run('op', fn); // 0 fails, 1 answers
    await pool.run('op', fn); // sticky on 1
    primaryDown = false;
    now = 1500;
    await expect(pool.run('op', fn)).resolves.toBe(0); // cooldown over, back on primary
    expect(calls).toEqual([0, 1, 1, 0]);
  });

  it('does not retry a non-transport error on another endpoint', async () => {
    const onFailover = jest.fn();
    const pool = new RpcFailover('evm', ['https://a.example', 'https://b.example'], {
      onFailover,
      logger: quietLogger,
    });
    const revert = Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' });
    const fn = jest.fn(async () => {
      throw revert;
    });

    await expect(pool.run('eth_call', fn)).rejects.toBe(revert);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onFailover).not.toHaveBeenCalled();
  });

  it('rethrows the last error when every endpoint fails', async () => {
    const pool = new RpcFailover('solana', ['https://a.example', 'https://b.example'], {
      logger: quietLogger,
    });
    const last = fetchFailed('EAI_AGAIN');
    const fn = jest.fn(async (i: number) => {
      throw i === 0 ? fetchFailed('ENOTFOUND') : last;
    });
    await expect(pool.run('op', fn)).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('calls a single URL once and never fails over', async () => {
    const onFailover = jest.fn();
    const pool = new RpcFailover('evm', ['https://a.example'], { onFailover, logger: quietLogger });
    const err = fetchFailed('ENOTFOUND');
    const fn = jest.fn(async () => {
      throw err;
    });
    await expect(pool.run('op', fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onFailover).not.toHaveBeenCalled();
    expect(quietLogger.warn).not.toHaveBeenCalled();
  });
});

describe('rebaseUrl', () => {
  it('moves a gRPC-web method path onto another endpoint', () => {
    expect(
      rebaseUrl(
        'https://a.example/sui.rpc.v2.LedgerService/GetObject',
        'https://a.example/',
        'https://b.example/key/',
      ),
    ).toBe('https://b.example/key/sui.rpc.v2.LedgerService/GetObject');
  });

  it('maps the bare primary URL to the endpoint', () => {
    expect(rebaseUrl('https://a.example', 'https://a.example', 'https://b.example/x')).toBe(
      'https://b.example/x',
    );
  });
});

describe('createFailoverFetch', () => {
  const urls = ['https://a.example', 'https://b.example'];
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' });

  it('re-sends the same request to the secondary on a transport failure', async () => {
    const baseFetch = jest.fn(async (url: string, _init?: RequestInit) => {
      if (url.startsWith('https://a.example')) throw fetchFailed('ENOTFOUND');
      return json({ jsonrpc: '2.0', id: 1, result: 42 });
    });
    const onFailover = jest.fn();
    const f = createFailoverFetch(
      new RpcFailover('solana', urls, { onFailover, logger: quietLogger }),
      {
        baseFetch,
      },
    );

    const res = await f('https://a.example', { method: 'POST', body });
    await expect(res.json()).resolves.toMatchObject({ result: 42 });
    expect(baseFetch.mock.calls.map((c) => c[0])).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(baseFetch.mock.calls[1][1]).toMatchObject({ method: 'POST', body });
    expect(onFailover).toHaveBeenCalledWith('solana');
  });

  it('fails over on HTTP 429 and 5xx', async () => {
    for (const status of [429, 502, 503]) {
      const baseFetch = jest.fn(async (url: string) =>
        url.startsWith('https://a.example')
          ? new Response('busy', { status })
          : json({ jsonrpc: '2.0', id: 1, result: 1 }),
      );
      const f = createFailoverFetch(new RpcFailover('solana', urls, { logger: quietLogger }), {
        baseFetch,
      });
      const res = await f('https://a.example', { method: 'POST', body });
      expect(res.status).toBe(200);
      expect(baseFetch).toHaveBeenCalledTimes(2);
    }
  });

  it('fails over on a pruned-history JSON-RPC error', async () => {
    const baseFetch = jest.fn(async (url: string) =>
      url.startsWith('https://a.example')
        ? json({
            jsonrpc: '2.0',
            id: 1,
            error: { code: -32000, message: 'block range is too large' },
          })
        : json({ jsonrpc: '2.0', id: 1, result: [] }),
    );
    const f = createFailoverFetch(new RpcFailover('solana', urls, { logger: quietLogger }), {
      baseFetch,
    });
    const res = await f('https://a.example', { method: 'POST', body });
    await expect(res.json()).resolves.toMatchObject({ result: [] });
  });

  it('returns a request-level JSON-RPC error without trying another endpoint', async () => {
    const baseFetch = jest.fn(async () =>
      json({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32002, message: 'Transaction simulation failed: custom program error' },
      }),
    );
    const f = createFailoverFetch(new RpcFailover('solana', urls, { logger: quietLogger }), {
      baseFetch,
    });
    const res = await f('https://a.example', { method: 'POST', body });
    await expect(res.json()).resolves.toMatchObject({ error: { code: -32002 } });
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });

  it('returns the last retryable response when every endpoint is down', async () => {
    const baseFetch = jest.fn(async (_url: string) => new Response('down', { status: 503 }));
    const f = createFailoverFetch(new RpcFailover('sui', urls, { logger: quietLogger }), {
      baseFetch,
    });
    const res = await f('https://a.example/svc/M', { method: 'POST', body: 'AAAA' });
    expect(res.status).toBe(503);
    expect(baseFetch.mock.calls.map((c) => c[0])).toEqual([
      'https://a.example/svc/M',
      'https://b.example/svc/M',
    ]);
  });

  it('times out a stalled attempt and fails over', async () => {
    const baseFetch = jest.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          if (url.startsWith('https://b.example')) {
            resolve(json({ jsonrpc: '2.0', id: 1, result: 7 }));
            return;
          }
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        }),
    );
    const f = createFailoverFetch(new RpcFailover('solana', urls, { logger: quietLogger }), {
      baseFetch,
      attemptTimeoutMs: 20,
    });
    const res = await f('https://a.example', { method: 'POST', body });
    await expect(res.json()).resolves.toMatchObject({ result: 7 });
  });

  it('does not fail over when the caller aborts', async () => {
    const controller = new AbortController();
    const baseFetch = jest.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        }),
    );
    const f = createFailoverFetch(new RpcFailover('sui', urls, { logger: quietLogger }), {
      baseFetch,
    });
    const pending = f('https://a.example/svc/M', { method: 'POST', signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted/);
    expect(baseFetch).toHaveBeenCalledTimes(1);
  });
});
