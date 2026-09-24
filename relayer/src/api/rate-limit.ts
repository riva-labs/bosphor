import { APP_ID_HEADER, parseAppId } from './app-id';

/**
 * A small in-memory fixed-window rate limiter for the integrator API.
 *
 * The relayer runs as a single process per deployment, so a process-local
 * counter is enough: no shared store, no extra dependency. Each key (an IP, an
 * app id, or an IP scoped to the CPU-heavy encode route) gets `limit` requests
 * per `windowMs`. State is bounded: expired windows are swept periodically.
 */
export interface HitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Milliseconds until the current window resets. */
  resetInMs: number;
}

export class FixedWindowLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  private hitsSinceSweep = 0;

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    /** Sweep expired windows every this many hits (keeps memory bounded). */
    private readonly sweepEvery = 1000,
  ) {}

  hit(key: string, limit: number): HitResult {
    const now = this.now();
    if (++this.hitsSinceSweep >= this.sweepEvery) this.sweep(now);

    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + this.windowMs };
      this.windows.set(key, w);
    }
    const resetInMs = w.resetAt - now;
    if (w.count >= limit) {
      return { allowed: false, limit, remaining: 0, resetInMs };
    }
    w.count++;
    return { allowed: true, limit, remaining: limit - w.count, resetInMs };
  }

  /** Number of tracked windows (for tests and sanity checks). */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    this.hitsSinceSweep = 0;
    for (const [key, w] of this.windows) {
      if (w.resetAt <= now) this.windows.delete(key);
    }
  }
}

/** Structural request shape the middleware reads (a subset of express.Request). */
export interface RateLimitRequest {
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/** Structural response shape the middleware writes (node http.ServerResponse). */
export interface RateLimitResponse {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

export interface RateLimitConfig {
  enabled: boolean;
  windowMs: number;
  /** Requests per window per client IP, across /blob, /blob/encode and /quote. */
  perIp: number;
  /** Requests per window per app id (only when an X-Bosphor-App header is sent). */
  perApp: number;
  /** Extra, tighter per-IP budget for the CPU-heavy POST /blob/encode. */
  encodePerIp: number;
  /**
   * Trust proxy headers for the client IP. Only enable when the relayer is
   * reachable exclusively through a proxy that sets them (Cloudflare tunnel +
   * nginx); otherwise a client could spoof its IP and dodge the limit.
   */
  trustProxy: boolean;
}

/** Which budget tripped, for logs and the 429 metric label. */
export type RateLimitScope = 'ip' | 'app' | 'encode';

function firstHeader(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : undefined;
}

/**
 * Resolve the client IP. Without `trustProxy` the socket peer is used, so proxy
 * headers can never be spoofed to evade the limiter. With it, Cloudflare's
 * CF-Connecting-IP wins, then the left-most X-Forwarded-For entry (the original
 * client as recorded by the first proxy).
 */
export function clientIp(req: RateLimitRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = firstHeader(req.headers['cf-connecting-ip']);
    if (cf) return cf;
    const xff = firstHeader(req.headers['x-forwarded-for']);
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

/**
 * Express middleware enforcing the per-IP, per-app and encode budgets on the
 * integrator routes. Mount it on /blob and /quote BEFORE the body parser so an
 * over-limit client is rejected without the relayer reading a 10 MiB body.
 * Preflights (OPTIONS) and non-POST requests are never counted.
 */
export function createRateLimitMiddleware(
  cfg: RateLimitConfig,
  opts: { now?: () => number; onLimited?: (scope: RateLimitScope) => void } = {},
): (req: RateLimitRequest, res: RateLimitResponse, next: () => void) => void {
  const limiter = new FixedWindowLimiter(cfg.windowMs, opts.now);

  return (req, res, next) => {
    if (!cfg.enabled || req.method !== 'POST') return next();

    const ip = clientIp(req, cfg.trustProxy);
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const checks: { scope: RateLimitScope; key: string; limit: number }[] = [
      { scope: 'ip', key: `ip:${ip}`, limit: cfg.perIp },
    ];
    if (path === '/blob/encode' || path.startsWith('/blob/encode/')) {
      checks.push({ scope: 'encode', key: `encode:${ip}`, limit: cfg.encodePerIp });
    }
    // A malformed app id is left for the controller to reject with a 400; only a
    // valid one gets its own bucket.
    const app = parseAppId(req.headers[APP_ID_HEADER.toLowerCase()]);
    if (app.ok && app.appId) {
      checks.push({ scope: 'app', key: `app:${app.appId}`, limit: cfg.perApp });
    }

    let tightest: { scope: RateLimitScope; result: HitResult } | null = null;
    for (const c of checks) {
      const result = limiter.hit(c.key, c.limit);
      if (!result.allowed) {
        opts.onLimited?.(c.scope);
        const retryAfter = Math.max(1, Math.ceil(result.resetInMs / 1000));
        res.statusCode = 429;
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('X-RateLimit-Limit', String(result.limit));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            statusCode: 429,
            error: 'Too Many Requests',
            message: `rate limit exceeded (${c.scope}); retry after ${retryAfter}s`,
          }),
        );
        return;
      }
      if (!tightest || result.remaining < tightest.result.remaining) {
        tightest = { scope: c.scope, result };
      }
    }
    if (tightest) {
      res.setHeader('X-RateLimit-Limit', String(tightest.result.limit));
      res.setHeader('X-RateLimit-Remaining', String(tightest.result.remaining));
    }
    next();
  };
}
