/**
 * Small HTTP helpers shared by every relayer call: `Retry-After` parsing and a
 * bounded, abortable retry loop. Runtime-agnostic (no Node built-ins), so they
 * work the same in Node and in the browser.
 */

import { isRetryableStatus } from "./errors.js";

export { isRetryableStatus };

/**
 * Parse an HTTP `Retry-After` header value into milliseconds from `now`.
 * Accepts both forms the spec allows: delay seconds (`"30"`) and an HTTP-date
 * (`"Sun, 27 Sep 2026 12:00:45 GMT"`). A date in the past yields 0. Returns
 * `undefined` for a missing or unparseable value.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  // Only accept something that looks like a date, so "-3" or "soon" are rejected
  // instead of being coerced by Date.parse.
  if (!/[a-z]/i.test(v)) return undefined;
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}

/**
 * Read `Retry-After` (in milliseconds) from a fetch-like response. Returns
 * `undefined` when the response exposes no headers or has no such header.
 */
export function readRetryAfterMs(res: {
  headers?: { get(name: string): string | null } | undefined;
}): number | undefined {
  const get = res.headers?.get;
  if (typeof get !== "function") return undefined;
  return parseRetryAfter(res.headers!.get("retry-after"));
}

/**
 * Sleep for `ms`, rejecting early with the signal's reason if it aborts mid-wait.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Bounds of a retry loop. Every field is optional; the defaults depend on the
 * call (see `DEFAULT_UPLOAD_RETRY` for uploads).
 */
export interface RetryPolicy {
  /** Total attempts including the first one. */
  maxAttempts?: number;
  /** Give up once this much time has passed since the first attempt, in ms. */
  maxElapsedMs?: number;
  /** First backoff delay in ms; doubles on every retry. */
  baseDelayMs?: number;
  /** Upper bound of one backoff delay in ms (a `Retry-After` may exceed it). */
  maxDelayMs?: number;
}

/** Internal options of {@link withRelayerRetry}. */
export interface WithRetryOptions extends RetryPolicy {
  /** Decide whether a thrown error is worth another attempt. */
  shouldRetry: (err: unknown) => boolean;
  /** Abort the loop (and the wait between attempts) with the signal's reason. */
  signal?: AbortSignal | undefined;
  /** Sleep implementation (tests inject a recorder). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Run `fn` until it succeeds, retrying errors `shouldRetry` accepts with
 * exponential backoff. A `retryAfterMs` on the error (from a `Retry-After`
 * header) replaces the computed backoff. When the next wait would overrun
 * `maxElapsedMs`, or `maxAttempts` is reached, the last error is rethrown: the
 * loop always ends loudly, never with a made up result.
 */
export async function withRelayerRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: WithRetryOptions,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 8;
  const maxElapsedMs = opts.maxElapsedMs ?? 60_000;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const wait = opts.sleep ?? sleep;
  const started = Date.now();

  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason;
      if (attempt >= maxAttempts || !opts.shouldRetry(err)) throw err;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const retryAfter = (err as { retryAfterMs?: unknown }).retryAfterMs;
      const delay = typeof retryAfter === "number" && retryAfter >= 0 ? retryAfter : backoff;
      if (Date.now() - started + delay > maxElapsedMs) throw err;
      await wait(delay, opts.signal);
    }
  }
}
