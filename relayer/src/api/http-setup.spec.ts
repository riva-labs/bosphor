import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { IngestController } from '../ingest/ingest.controller';
import { IntentIngest } from '../ingest/intent-ingest.service';
import { QuoteController } from '../pricing/quote.controller';
import { QuoteService } from '../pricing/quote.service';
import { configureHttp } from './http-setup';

/**
 * HTTP integration: boots the real controllers behind the exact middleware stack
 * main.ts uses (CORS -> rate limit -> raw body), with the services stubbed, and
 * drives it over real HTTP.
 */
describe('configureHttp (integrator API over HTTP)', () => {
  let app: INestApplication;
  let base: string;
  const ingest = {
    ingest: jest.fn().mockResolvedValue({ ok: true, intentId: '0xabc', blobId: 'b', size: 5 }),
    encode: jest.fn().mockResolvedValue({ blobId: 'b', size: 5 }),
  };
  const quote = {
    quote: jest.fn().mockResolvedValue({
      originToken: 'ETH',
      escrowNative: 1n,
      forwardNative: 2n,
      totalNative: 3n,
      breakdown: {},
      prices: {},
    }),
  };
  const metrics = { recordRateLimited: jest.fn() };

  async function boot(cfg: Record<string, unknown>): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      controllers: [IngestController, QuoteController],
      providers: [
        { provide: IntentIngest, useValue: ingest },
        { provide: QuoteService, useValue: quote },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    const config = { get: (k: string) => cfg[k] };
    configureHttp(app, config as never, metrics);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    await app?.close();
    jest.clearAllMocks();
  });

  it('answers a CORS preflight for POST /blob/:id from an arbitrary origin', async () => {
    await boot({ CORS_ORIGINS: '*', RATE_LIMIT_PER_IP: 100 });
    const res = await fetch(`${base}/blob/0xabc`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://some-dapp.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-bosphor-app',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'x-bosphor-app',
    );
  });

  it('accepts a cross-origin POST ingest and records the app id', async () => {
    await boot({ CORS_ORIGINS: '*', RATE_LIMIT_PER_IP: 100 });
    const res = await fetch(`${base}/blob/0xabc`, {
      method: 'POST',
      headers: {
        Origin: 'https://some-dapp.example',
        'content-type': 'application/octet-stream',
        'X-Bosphor-App': 'Some-Dapp',
      },
      body: Buffer.from('hello'),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(ingest.ingest).toHaveBeenCalledWith('0xabc', Buffer.from('hello'), 'some-dapp');
  });

  it('only allows listed origins (plus the dashboard) with an explicit allowlist', async () => {
    await boot({
      CORS_ORIGINS: 'https://demo.bosphor.xyz',
      DASHBOARD_ORIGIN: 'https://status.bosphor.xyz',
      RATE_LIMIT_PER_IP: 100,
    });
    const preflight = (origin: string) =>
      fetch(`${base}/quote`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
      });
    expect(
      (await preflight('https://demo.bosphor.xyz')).headers.get('access-control-allow-origin'),
    ).toBe('https://demo.bosphor.xyz');
    expect(
      (await preflight('https://status.bosphor.xyz')).headers.get('access-control-allow-origin'),
    ).toBe('https://status.bosphor.xyz');
    expect(
      (await preflight('https://evil.example')).headers.get('access-control-allow-origin'),
    ).toBeNull();
  });

  it('returns 429 with Retry-After over the per-IP budget, without reaching the controller', async () => {
    await boot({ RATE_LIMIT_PER_IP: 2, RATE_LIMIT_WINDOW_MS: 60_000 });
    const post = () =>
      fetch(`${base}/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sizeBytes: 1, originToken: 'ETH' }),
      });
    expect((await post()).status).toBe(201);
    expect((await post()).status).toBe(201);
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(quote.quote).toHaveBeenCalledTimes(2);
    expect(metrics.recordRateLimited).toHaveBeenCalledWith('ip');
  });

  it('rejects a malformed X-Bosphor-App on /quote with 400', async () => {
    await boot({ RATE_LIMIT_PER_IP: 100 });
    const res = await fetch(`${base}/quote`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Bosphor-App': 'bad id!' },
      body: JSON.stringify({ sizeBytes: 1, originToken: 'ETH' }),
    });
    expect(res.status).toBe(400);
    expect(quote.quote).not.toHaveBeenCalled();
  });

  it('does not serve /metrics on the public API port', async () => {
    await boot({});
    expect((await fetch(`${base}/metrics`)).status).toBe(404);
  });
});
