import { APP_ID_HEADER } from './app-id';

/**
 * CORS options handed to Nest's `app.enableCors`. Typed locally (a structural
 * subset of the `cors` package options) so the relayer does not need @types/cors.
 */
export interface RelayerCorsOptions {
  origin: '*' | string[];
  methods: string[];
  allowedHeaders: string[];
  exposedHeaders: string[];
  maxAge: number;
}

/**
 * Split a comma-separated origin allowlist into trimmed, non-empty entries.
 * Trailing slashes are dropped because browsers never send one in `Origin`.
 */
export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0);
}

/**
 * Build the relayer's CORS policy.
 *
 * The integrator API (POST /blob/:intentId, POST /blob/encode, POST /quote) is
 * called straight from browser dApps, so preflight + POST must succeed from the
 * configured origins. `CORS_ORIGINS` is a comma-separated allowlist; `*` (the
 * default) opens the API to any origin. With an explicit allowlist the dashboard
 * origin is always appended so the public feed at status.bosphor.xyz keeps
 * working without having to be listed twice.
 *
 * No credentials are ever allowed: the API is unauthenticated, so a wildcard
 * origin is safe (browsers refuse `*` together with credentials anyway).
 */
export function buildCorsOptions(opts: {
  corsOrigins?: string;
  dashboardOrigin?: string;
}): RelayerCorsOptions {
  const listed = parseCorsOrigins(opts.corsOrigins ?? '*');
  const wildcard = listed.length === 0 || listed.includes('*');

  let origin: '*' | string[];
  if (wildcard) {
    origin = '*';
  } else {
    const all = [...listed];
    const dashboard = opts.dashboardOrigin?.replace(/\/+$/, '');
    if (dashboard && !all.includes(dashboard)) all.push(dashboard);
    origin = all;
  }

  return {
    origin,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', APP_ID_HEADER],
    // Let browser clients read the backoff hints on 429 / 503 responses.
    exposedHeaders: ['Retry-After', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    // Cache preflights for 10 minutes so a dApp does not pay an OPTIONS per call.
    maxAge: 600,
  };
}
