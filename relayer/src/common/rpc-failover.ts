import { Logger } from '@nestjs/common';
import { isTransientRpcError } from '../observability/transient-rpc-error';

/**
 * RPC endpoint failover shared by the EVM, Sui and Solana clients (#524).
 *
 * The relayer's RPC env vars (EVM_RPC_URL, SUI_GRPC_URL, SOLANA_RPC_URL) accept
 * a comma-separated list. The first URL is the primary; the rest are tried in
 * order when a call fails with a transport-level error (connection refused, DNS
 * failure, timeout, 429/5xx, a pruned or range-limited log query). Errors that
 * describe the request itself (a contract revert, a Move abort, a bad argument)
 * are returned as-is: another endpoint would give the same answer.
 *
 * A single URL takes none of these paths, so it behaves exactly as before.
 */

export type RpcChain = 'evm' | 'sui' | 'solana';

/** Per-attempt timeout applied only when more than one URL is configured. */
export const RPC_FAILOVER_ATTEMPT_TIMEOUT_MS = 20_000;

/**
 * How long the relayer stays on a fallback endpoint before trying the primary
 * again, so a recovered primary is picked back up without per-call probing.
 */
export const RPC_FAILOVER_PRIMARY_RETRY_MS = 60_000;

/** Split a comma-separated RPC URL setting into its trimmed, non-empty URLs. */
export function parseRpcUrls(value: string | undefined | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/** Host part of a URL for logs. Provider URLs often carry an API key in the path or query. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(invalid url)';
  }
}

const TRANSPORT_MESSAGE_RE =
  /fetch failed|network error|enotfound|eai_again|econnreset|econnrefused|econnaborted|etimedout|ehostunreach|enetunreach|socket hang up|other side closed|und_err|timed out|timeout|bad gateway|gateway time-?out|service unavailable|too many requests|rate limit|server response (5\d\d|429)|error code: 5\d\d/i;

/**
 * Whether an error is a transport failure worth retrying on another endpoint.
 * Builds on the shared transient classifier and adds DNS and fetch-level
 * failures that the Sentry classifier does not need to know about.
 */
export function isTransportFailure(err: unknown, depth = 0): boolean {
  if (depth > 5 || !err || typeof err !== 'object') return false;
  if (isTransientRpcError(err)) return true;

  const code = (err as { code?: unknown }).code;
  if (
    typeof code === 'string' &&
    /^(ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|EHOST|ENET|UND_ERR)/.test(code)
  ) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && TRANSPORT_MESSAGE_RE.test(message)) return true;

  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isTransportFailure(cause, depth + 1);
  return false;
}

/**
 * JSON-RPC error messages that mean "this endpoint cannot serve the query"
 * rather than "the query is wrong": pruned history, block range caps, a node
 * lagging head, rate limits. Another endpoint may well answer these.
 */
const RETRYABLE_JSON_RPC_MESSAGE_RE =
  /block range|range (is )?too (large|wide|big)|range limit|exceed(s|ed)? .*range|too many blocks|max(imum)? .*range|pruned|history .*(not available|unavailable)|missing trie node|header not found|beyond current head|rate limit|too many requests|limit exceeded|capacity exceeded|service unavailable|temporarily unavailable|node is (behind|unhealthy)|timeout|timed out/i;

/** JSON-RPC error codes with the same meaning across EVM and Solana providers. */
const RETRYABLE_JSON_RPC_CODES = new Set([
  -32005, // limit exceeded / Solana node unhealthy
  -32029, // rate limited (some providers)
  429,
]);

/** Whether a JSON-RPC `error` object describes an endpoint limitation, not the request. */
export function isRetryableJsonRpcError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'number' && RETRYABLE_JSON_RPC_CODES.has(code)) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && RETRYABLE_JSON_RPC_MESSAGE_RE.test(message);
}

export interface RpcFailoverOptions {
  /** Called once per failover hop (feeds bosphor_relayer_rpc_failover_total). */
  onFailover?: (chain: RpcChain) => void;
  /** Which errors move on to the next endpoint. Defaults to isTransportFailure. */
  isFailoverError?: (err: unknown) => boolean;
  primaryRetryMs?: number;
  logger?: Pick<Logger, 'warn'>;
  now?: () => number;
}

/**
 * Ordered endpoint pool. `run` calls `fn` with the active endpoint and, on a
 * failover-class error, re-issues the same call on the next one. The endpoint
 * that answered becomes active (sticky) so a dead primary is not re-tried on
 * every call; after `primaryRetryMs` the primary is tried first again.
 */
export class RpcFailover {
  private active = 0;
  private leftPrimaryAt = 0;
  private readonly logger: Pick<Logger, 'warn'>;
  private readonly isFailoverError: (err: unknown) => boolean;
  private readonly primaryRetryMs: number;
  private readonly now: () => number;

  constructor(
    readonly chain: RpcChain,
    readonly urls: readonly string[],
    private readonly opts: RpcFailoverOptions = {},
  ) {
    if (urls.length === 0) throw new Error(`${chain}: no RPC URL configured`);
    this.logger = opts.logger ?? new Logger(`RpcFailover:${chain}`);
    this.isFailoverError =
      opts.isFailoverError ??
      ((err) => err instanceof RetryableResponseError || isTransportFailure(err));
    this.primaryRetryMs = opts.primaryRetryMs ?? RPC_FAILOVER_PRIMARY_RETRY_MS;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.urls.length;
  }

  /** Index of the endpoint the next call starts from. */
  get activeIndex(): number {
    return this.active;
  }

  async run<T>(op: string, fn: (index: number, url: string) => Promise<T>): Promise<T> {
    if (this.urls.length === 1) return fn(0, this.urls[0]);

    if (this.active !== 0 && this.now() - this.leftPrimaryAt >= this.primaryRetryMs) {
      this.active = 0;
    }
    const start = this.active;
    let lastErr: unknown;
    for (let step = 0; step < this.urls.length; step++) {
      const i = (start + step) % this.urls.length;
      try {
        const result = await fn(i, this.urls[i]);
        if (i !== this.active) {
          if (this.active === 0) this.leftPrimaryAt = this.now();
          this.active = i;
        }
        return result;
      } catch (err) {
        lastErr = err;
        if (!this.isFailoverError(err) || step === this.urls.length - 1) throw err;
        const next = this.urls[(i + 1) % this.urls.length];
        this.logger.warn(
          `${this.chain} RPC ${rpcHost(this.urls[i])} failed on ${op} ` +
            `(${describe(err)}); failing over to ${rpcHost(next)}`,
        );
        this.opts.onFailover?.(this.chain);
      }
    }
    throw lastErr;
  }
}

function describe(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  return message.slice(0, 160);
}

/** Thrown from a fetch attempt that returned a response another endpoint may do better on. */
export class RetryableResponseError extends Error {
  constructor(
    readonly response: Response,
    reason: string,
  ) {
    super(reason);
    this.name = 'RetryableResponseError';
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * A `fetch` that sends each request to the active endpoint of `failover`,
 * moving on to the next one on a transport failure, a per-attempt timeout, an
 * HTTP 429/5xx, or a JSON-RPC error that marks an endpoint limitation. Used by
 * the Sui gRPC-web transport and the Solana Connection, both of which accept a
 * custom fetch. The request URL is rebased from the primary onto each endpoint,
 * so gRPC-web method paths are preserved.
 *
 * Requests are re-sent byte for byte: a signed transaction is the same tx on
 * every endpoint (same digest / signature), so a re-send cannot double-spend.
 * When every endpoint fails with a retryable response, the last response is
 * returned so the client library applies its normal handling.
 */
export function createFailoverFetch(
  failover: RpcFailover,
  opts: { attemptTimeoutMs?: number; baseFetch?: FetchLike } = {},
): FetchLike {
  const baseFetch: FetchLike = opts.baseFetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = opts.attemptTimeoutMs ?? RPC_FAILOVER_ATTEMPT_TIMEOUT_MS;
  const primary = failover.urls[0];

  return async (input, init) => {
    const url = String(input);
    const op = describeRequest(url, init);
    try {
      return await failover.run(op, async (_i, endpoint) => {
        const target = rebaseUrl(url, primary, endpoint);
        const res = await fetchWithTimeout(baseFetch, target, init, timeoutMs);
        const reason = await retryableResponseReason(res);
        if (reason) throw new RetryableResponseError(res, reason);
        return res;
      });
    } catch (err) {
      if (err instanceof RetryableResponseError) return err.response;
      throw err;
    }
  };
}

/** Move a request URL from the primary endpoint onto `endpoint`, keeping its path suffix. */
export function rebaseUrl(url: string, primary: string, endpoint: string): string {
  const from = primary.replace(/\/+$/, '');
  const to = endpoint.replace(/\/+$/, '');
  if (from === to) return url;
  if (url === primary || url === from) return endpoint;
  if (!url.startsWith(from)) return url;
  return to + url.slice(from.length);
}

async function fetchWithTimeout(
  baseFetch: FetchLike,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const outer = init?.signal;
  if (outer?.aborted) controller.abort(outer.reason);
  const onOuterAbort = () => controller.abort(outer?.reason);
  outer?.addEventListener('abort', onOuterAbort);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await baseFetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Our own timer firing is a transport timeout (fail over); a caller abort is not.
    if (timedOut) throw new Error(`request timeout after ${timeoutMs}ms`, { cause: err });
    throw err;
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

/** gRPC status codes that mean the endpoint, not the request, failed. */
const RETRYABLE_GRPC_STATUS = new Set(['4', '8', '14']); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, UNAVAILABLE

async function retryableResponseReason(res: Response): Promise<string | null> {
  if (res.status === 429 || res.status >= 500) return `HTTP ${res.status}`;
  const grpcStatus = res.headers.get('grpc-status');
  if (grpcStatus && RETRYABLE_GRPC_STATUS.has(grpcStatus)) return `grpc-status ${grpcStatus}`;

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return null;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return null;
  }
  const items = Array.isArray(body) ? body : [body];
  for (const item of items) {
    const error = (item as { error?: unknown })?.error;
    if (isRetryableJsonRpcError(error)) {
      return `JSON-RPC error: ${String((error as { message?: unknown }).message).slice(0, 120)}`;
    }
  }
  return null;
}

function describeRequest(url: string, init: RequestInit | undefined): string {
  if (typeof init?.body === 'string') {
    try {
      const parsed = JSON.parse(init.body) as { method?: unknown } | { method?: unknown }[];
      const method = Array.isArray(parsed) ? parsed[0]?.method : parsed.method;
      if (typeof method === 'string') return method;
    } catch {
      // not JSON-RPC
    }
  }
  try {
    return new URL(url).pathname.split('/').pop() || 'request';
  } catch {
    return 'request';
  }
}
