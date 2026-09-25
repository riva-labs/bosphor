/**
 * Shared building blocks of the one-call `store()` flow, used by every chain
 * client so the EVM and Solana paths stay byte-for-byte identical where they
 * overlap (encode, upload, fetch wiring, defaults) and only differ where the
 * chain genuinely differs (quote vs nativeFee, receipt vs PDA).
 *
 * These are the load-bearing steps; keeping them in one place is what lets the two
 * clients present the SAME API without drifting.
 */

import type { BlobEncoding, ComputeBlob, Hex } from "./types.js";
import type { PricedQuote } from "./quote.js";
import { RelayerUploadError } from "./errors.js";

/** Default committed storage duration, in Walrus epochs. */
export const DEFAULT_EPOCHS = 5;
/** Default seconds added to `now` to derive an intent deadline. */
export const DEFAULT_DEADLINE_SECONDS = 3600; // 1 hour
/** Default `awaitProof` timeout budget, in milliseconds. */
export const DEFAULT_TIMEOUT_MS: number = 5 * 60_000;
/** Default `awaitProof` poll interval, in milliseconds. */
export const DEFAULT_POLL_MS = 3_000;

/**
 * Request header carrying the integrator application id to the relayer. The
 * relayer records it with every intent so usage by live dApps can be told apart
 * from scripts and tests. It is attribution only, never authentication.
 */
export const APP_ID_HEADER = "X-Bosphor-App";

/**
 * Accepted app id format: a short slug that starts with a letter or digit, then
 * letters, digits, `-`, `_` or `.`, at most 64 characters. Mirrors the relayer.
 */
export const APP_ID_PATTERN: RegExp = /^[a-z0-9][a-z0-9\-_.]{0,63}$/i;

/**
 * Validate an optional app id at client construction, so a typo fails fast and
 * locally instead of as a 400 from the relayer mid-flow. Returns the id
 * unchanged, or undefined when none was given.
 */
export function validateAppId(appId: string | undefined): string | undefined {
  if (appId === undefined) return undefined;
  if (!APP_ID_PATTERN.test(appId)) {
    throw new Error(
      `invalid appId "${appId}": use a short slug (letters, digits, "-", "_", "."; max 64 chars)`,
    );
  }
  return appId;
}

/** Relayer request headers: the content type plus the app id when configured. */
export function relayerHeaders(contentType: string, appId?: string): Record<string, string> {
  const headers: Record<string, string> = { "content-type": contentType };
  if (appId) headers[APP_ID_HEADER] = appId;
  return headers;
}

/** Storage terms for `encode()`, and for the one-call `store()` / `storePriced()`. */
export interface EncodeOptions {
  /** Storage duration in Walrus epochs. Defaults to the client default (5). */
  epochs?: number;
  /** Absolute deadline as unix seconds. Overrides the derived default when set. */
  deadline?: bigint;
}

/** Polling controls for `awaitProof()`, and for the proof wait inside `store()`. */
export interface AwaitProofOptions {
  /** Give up after this many milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Poll interval in milliseconds. Defaults to 3 seconds. */
  pollMs?: number;
  /**
   * Cancel the wait (and the whole `store` flow) when this signal aborts. On abort
   * the pending promise rejects with the signal's reason, the standard cancellation
   * contract used by `fetch`. The on-chain intent is not rolled back: if it aborted
   * while awaiting the proof, re-poll with `awaitProof(intentId)`; if it aborted
   * during or before the upload, re-run `upload(intentId, data)` first (the relayer
   * needs the bytes to execute), then re-poll.
   */
  signal?: AbortSignal;
}

/**
 * A progress event emitted by `store()` / `storePriced()` as each step completes,
 * so a UI can show where a 1 to 3 minute round trip is.
 *
 * - `encoded`: the blob id and commitment fields are derived (no chain call yet).
 * - `quoted`: the price is known. `amount` is the native value attached at submit;
 *   `quote` is set on the priced path.
 * - `submitted`: the intent is on-chain (`txHash` is the EVM tx hash or Solana signature).
 * - `uploaded`: the relayer accepted the bytes.
 * - `proven`: the proof landed and was verified on the origin chain.
 */
export type StoreProgress =
  | { step: "encoded"; encoded: EncodedIntent }
  | { step: "quoted"; amount: bigint; quote?: PricedQuote }
  | { step: "submitted"; intentId: Hex; txHash: string }
  | { step: "uploaded"; intentId: Hex }
  | { step: "proven"; intentId: Hex; blobId: Hex; endEpoch: bigint };

/** Options accepted by the one-call `store()` / `storePriced()`. */
export interface ProgressOptions {
  /**
   * Called synchronously after each step. An exception thrown here aborts the
   * flow (the on-chain intent is not rolled back; resume with `upload`/`awaitProof`).
   */
  onProgress?: (event: StoreProgress) => void;
}

/** Fields derived from the raw bytes plus the chosen storage terms. */
export interface EncodedIntent extends BlobEncoding {
  /** Committed storage duration in Walrus epochs. */
  storageEpochs: number;
  /** Intent deadline as unix seconds (u64). */
  deadline: bigint;
}

/**
 * A `fetch`-shaped function, injectable so tests never hit the network and so a
 * consumer can supply a custom agent (proxy, retries, auth).
 */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    body: Uint8Array;
    headers: Record<string, string>;
    /** Optional cancellation signal, forwarded to the underlying `fetch`. */
    signal?: AbortSignal | undefined;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Sleep for `ms`, rejecting early with the signal's reason if it aborts mid-wait.
 * Used by the poll loops so a cancellation is honored without waiting out the
 * current interval.
 */
/**
 * Whether an RPC/network failure is worth retrying: connection resets and
 * timeouts, rate limiting, and 5xx responses. Public RPCs drop connections
 * routinely, and a proof wait lasts minutes, so one such blip must not fail it.
 * Contract errors (reverts, CALL_EXCEPTION), programming errors and caller
 * aborts are never transient.
 */
export function isTransientRpcError(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { name?: unknown; code?: unknown; message?: unknown; status?: unknown };
  if (e.name === "AbortError") return false;
  const code = typeof e.code === "string" ? e.code : "";
  if (["CALL_EXCEPTION", "INVALID_ARGUMENT", "BAD_DATA"].includes(code)) return false;
  if (TRANSIENT_CODES.has(code)) return true;
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status !== undefined && (status === 429 || status >= 500)) return true;
  const msg = typeof e.message === "string" ? e.message : "";
  return TRANSIENT_MESSAGE.test(msg);
}

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_ERROR",
]);

const TRANSIENT_MESSAGE =
  /socket (hang up|disconnected)|network socket|fetch failed|timed? ?out|\b429\b|too many requests|\b50[0-4]\b|service unavailable|bad gateway/i;

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
 * Resolve the fetch implementation: the injected one if given, else the global
 * `fetch` wrapped to the injectable shape, else throw (never silently no-op).
 */
export function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected;
  if (typeof globalThis.fetch === "function") {
    return (url, init) => {
      const requestInit: RequestInit = {
        method: init.method,
        body: init.body,
        headers: init.headers,
      };
      // Only set signal when present: exactOptionalPropertyTypes rejects an
      // explicit `undefined` for an optional property.
      if (init.signal) requestInit.signal = init.signal;
      return globalThis.fetch(url, requestInit);
    };
  }
  throw new Error("no fetch available; pass a fetch implementation in options");
}

/** Client defaults consulted by {@link encodeIntent}. */
export interface EncodeDefaults {
  defaultEpochs: number;
  deadlineSeconds: number;
}

/**
 * Encode raw bytes into the commitment fields: derive the blob id locally, verify
 * it matches the byte length, pick the storage duration, and compute the deadline.
 * No chain interaction happens here. Fails loudly if the blob id cannot be derived
 * or the reported size disagrees with the data. Shared by every chain client.
 */
export async function encodeIntent(
  computeBlob: ComputeBlob,
  data: Uint8Array,
  opts: EncodeOptions,
  defaults: EncodeDefaults,
): Promise<EncodedIntent> {
  if (data.length === 0) throw new Error("cannot store empty data");

  const { blobId, size, encodingType } = await computeBlob(data);
  if (size !== data.length) {
    throw new Error(`computeBlob reported size ${size} but data is ${data.length} bytes`);
  }

  const storageEpochs = opts.epochs ?? defaults.defaultEpochs;
  const deadline =
    opts.deadline ?? BigInt(Math.floor(Date.now() / 1000) + defaults.deadlineSeconds);

  return { blobId, size, encodingType, storageEpochs, deadline };
}

/**
 * Upload the raw blob bytes out-of-band to the relayer:
 * `POST {relayerUrl}/blob/{intentId}` with the bytes as the raw body, plus the
 * `X-Bosphor-App` header when an app id is configured. Throws a
 * {@link RelayerUploadError} carrying the relayer's reason on any non-2xx. Shared
 * by every chain client.
 */
export async function uploadBlob(
  fetchFn: FetchLike,
  relayerUrl: string,
  intentId: Hex,
  data: Uint8Array,
  signal?: AbortSignal,
  appId?: string,
): Promise<void> {
  const res = await fetchFn(`${relayerUrl}/blob/${intentId}`, {
    method: "POST",
    body: data,
    headers: relayerHeaders("application/octet-stream", appId),
    signal,
  });

  if (!res.ok) {
    let reason: string;
    try {
      reason = await res.text();
    } catch {
      reason = "(no response body)";
    }
    throw new RelayerUploadError(intentId, res.status, reason);
  }
}
