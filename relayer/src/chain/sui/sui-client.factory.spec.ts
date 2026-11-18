import { SuiGrpcClient } from '@mysten/sui/grpc';
import { createSuiGrpcClient } from './sui-client.factory';

const quietLogger = { warn: jest.fn() };

/**
 * A minimal grpc-web-text reply: an empty message frame (decodes to the
 * default response) plus an OK trailer frame.
 */
function grpcWebOk(): Response {
  const trailer = Buffer.from('grpc-status:0\r\n');
  const frames = Buffer.concat([
    Buffer.from([0x00, 0, 0, 0, 0]),
    Buffer.from([0x80, 0, 0, 0, trailer.length]),
    trailer,
  ]);
  return new Response(frames.toString('base64'), {
    status: 200,
    headers: { 'content-type': 'application/grpc-web-text' },
  });
}

/** A trailers-only gRPC error reply, as a fullnode sends for a bad request. */
function grpcWebError(code: number, message: string): Response {
  return new Response(null, {
    status: 200,
    headers: {
      'content-type': 'application/grpc-web-text',
      'grpc-status': String(code),
      'grpc-message': message,
    },
  });
}

function dnsFailure(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo EAI_AGAIN a.example'), { code: 'EAI_AGAIN' }),
  });
}

describe('createSuiGrpcClient', () => {
  afterEach(() => quietLogger.warn.mockClear());

  it('builds the plain client for a single URL (unchanged behavior)', () => {
    const client = createSuiGrpcClient('https://fullnode.testnet.sui.io');
    expect(client).toBeInstanceOf(SuiGrpcClient);
    expect(client.network).toBe('testnet');
  });

  it('falls through a failing primary to the secondary, keeping the method path', async () => {
    const baseFetch = jest.fn(async (url: string | URL | Request) => {
      if (String(url).startsWith('https://a.example')) throw dnsFailure();
      return grpcWebOk();
    });
    const onFailover = jest.fn();
    const client = createSuiGrpcClient('https://a.example,https://b.example/', {
      baseFetch: baseFetch as typeof fetch,
      onFailover,
      logger: quietLogger,
    });

    const { response } = await client.ledgerService.getServiceInfo({});
    expect(response.checkpointHeight).toBeUndefined();
    expect(baseFetch.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://a.example/sui.rpc.v2.LedgerService/GetServiceInfo',
      'https://b.example/sui.rpc.v2.LedgerService/GetServiceInfo',
    ]);
    expect(onFailover).toHaveBeenCalledWith('sui');
  });

  it('fails over on a gRPC UNAVAILABLE status', async () => {
    const baseFetch = jest.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://a.example') ? grpcWebError(14, 'unavailable') : grpcWebOk(),
    );
    const client = createSuiGrpcClient('https://a.example,https://b.example', {
      baseFetch: baseFetch as typeof fetch,
      logger: quietLogger,
    });
    await client.ledgerService.getServiceInfo({});
    expect(baseFetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a request-level error on another endpoint', async () => {
    const baseFetch = jest.fn(async () => grpcWebError(3, 'invalid object id'));
    const onFailover = jest.fn();
    const client = createSuiGrpcClient('https://a.example,https://b.example', {
      baseFetch: baseFetch as typeof fetch,
      onFailover,
      logger: quietLogger,
    });
    await expect(client.ledgerService.getObject({ objectId: '0xzz' })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(baseFetch).toHaveBeenCalledTimes(1);
    expect(onFailover).not.toHaveBeenCalled();
  });
});
