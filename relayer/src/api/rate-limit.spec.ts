import {
  FixedWindowLimiter,
  RateLimitConfig,
  RateLimitRequest,
  clientIp,
  createRateLimitMiddleware,
} from './rate-limit';

function fakeRes() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: undefined as string | undefined,
    headers,
    setHeader(n: string, v: string) {
      headers[n] = v;
    },
    end(b?: string) {
      res.body = b;
    },
  };
  return res;
}

function req(o: Partial<RateLimitRequest> = {}): RateLimitRequest {
  return {
    method: 'POST',
    originalUrl: '/quote',
    headers: {},
    socket: { remoteAddress: '10.0.0.1' },
    ...o,
  };
}

const BASE: RateLimitConfig = {
  enabled: true,
  windowMs: 60_000,
  perIp: 3,
  perApp: 5,
  encodePerIp: 1,
  trustProxy: false,
};

describe('FixedWindowLimiter', () => {
  it('allows up to the limit, then rejects until the window resets', () => {
    let now = 0;
    const l = new FixedWindowLimiter(1000, () => now);
    expect(l.hit('k', 2).allowed).toBe(true);
    expect(l.hit('k', 2).remaining).toBe(0);
    const blocked = l.hit('k', 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.resetInMs).toBe(1000);
    now = 1000;
    expect(l.hit('k', 2).allowed).toBe(true);
  });

  it('sweeps expired windows so memory stays bounded', () => {
    let now = 0;
    const l = new FixedWindowLimiter(10, () => now, 3);
    l.hit('a', 1);
    l.hit('b', 1);
    now = 100;
    l.hit('c', 1); // third hit triggers a sweep of a and b
    expect(l.size).toBe(1);
  });
});

describe('clientIp', () => {
  const headers = { 'cf-connecting-ip': '1.1.1.1', 'x-forwarded-for': '2.2.2.2, 3.3.3.3' };

  it('ignores proxy headers unless TRUST_PROXY is on (no spoofing)', () => {
    expect(clientIp(req({ headers }), false)).toBe('10.0.0.1');
  });

  it('prefers CF-Connecting-IP when trusted', () => {
    expect(clientIp(req({ headers }), true)).toBe('1.1.1.1');
  });

  it('falls back to the left-most X-Forwarded-For entry when trusted', () => {
    expect(clientIp(req({ headers: { 'x-forwarded-for': '2.2.2.2, 3.3.3.3' } }), true)).toBe(
      '2.2.2.2',
    );
  });

  it('falls back to the socket peer when trusted but no header is present', () => {
    expect(clientIp(req(), true)).toBe('10.0.0.1');
  });
});

describe('createRateLimitMiddleware', () => {
  it('returns 429 with Retry-After once the per-IP budget is spent', () => {
    const onLimited = jest.fn();
    const mw = createRateLimitMiddleware(BASE, { now: () => 0, onLimited });
    const next = jest.fn();
    for (let i = 0; i < 3; i++) mw(req(), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(3);

    const res = fakeRes();
    mw(req(), res, next);
    expect(next).toHaveBeenCalledTimes(3);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBe('60');
    expect(JSON.parse(res.body!).statusCode).toBe(429);
    expect(onLimited).toHaveBeenCalledWith('ip');
  });

  it('keys by client IP: another IP has its own budget', () => {
    const mw = createRateLimitMiddleware(BASE, { now: () => 0 });
    const next = jest.fn();
    for (let i = 0; i < 4; i++) mw(req(), fakeRes(), next);
    const res = fakeRes();
    mw(req({ socket: { remoteAddress: '10.0.0.2' } }), res, next);
    expect(res.statusCode).toBe(200);
    expect(next).toHaveBeenCalledTimes(4);
  });

  it('applies the tighter encode budget to POST /blob/encode only', () => {
    const mw = createRateLimitMiddleware(BASE, { now: () => 0 });
    const next = jest.fn();
    mw(req({ originalUrl: '/blob/encode' }), fakeRes(), next);
    const res = fakeRes();
    mw(req({ originalUrl: '/blob/encode' }), res, next);
    expect(res.statusCode).toBe(429);
    // Ingest on the same IP still has per-IP budget left.
    const ok = fakeRes();
    mw(req({ originalUrl: '/blob/0xabc' }), ok, next);
    expect(ok.statusCode).toBe(200);
  });

  it('limits per app id across IPs when the header is present', () => {
    const cfg = { ...BASE, perIp: 100, perApp: 2 };
    const onLimited = jest.fn();
    const mw = createRateLimitMiddleware(cfg, { now: () => 0, onLimited });
    const next = jest.fn();
    const h = { 'x-bosphor-app': 'my-dapp' };
    mw(req({ headers: h, socket: { remoteAddress: 'a' } }), fakeRes(), next);
    mw(req({ headers: h, socket: { remoteAddress: 'b' } }), fakeRes(), next);
    const res = fakeRes();
    mw(req({ headers: h, socket: { remoteAddress: 'c' } }), res, next);
    expect(res.statusCode).toBe(429);
    expect(onLimited).toHaveBeenCalledWith('app');
  });

  it('never counts preflights or GETs, and is a no-op when disabled', () => {
    const mw = createRateLimitMiddleware({ ...BASE, perIp: 1 }, { now: () => 0 });
    const next = jest.fn();
    for (let i = 0; i < 5; i++) mw(req({ method: 'OPTIONS' }), fakeRes(), next);
    for (let i = 0; i < 5; i++) mw(req({ method: 'GET' }), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(10);

    const off = createRateLimitMiddleware({ ...BASE, enabled: false, perIp: 0 });
    const res = fakeRes();
    off(req(), res, next);
    expect(res.statusCode).toBe(200);
  });

  it('exposes the remaining budget on allowed responses', () => {
    const mw = createRateLimitMiddleware(BASE, { now: () => 0 });
    const res = fakeRes();
    mw(req(), res, jest.fn());
    expect(res.headers['X-RateLimit-Limit']).toBe('3');
    expect(res.headers['X-RateLimit-Remaining']).toBe('2');
  });
});
