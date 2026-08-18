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
import { RelayerUploadError } from "./errors.js";

/** Default committed storage duration, in Walrus epochs. */
export const DEFAULT_EPOCHS = 5;
/** Default seconds added to `now` to derive an intent deadline. */
export const DEFAULT_DEADLINE_SECONDS = 3600; // 1 hour
/** Default `awaitProof` timeout budget, in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** Default `awaitProof` poll interval, in milliseconds. */
export const DEFAULT_POLL_MS = 3_000;

export interface EncodeOptions {
  /** Storage duration in Walrus epochs. Defaults to the client default (5). */
  epochs?: number;
  /** Absolute deadline as unix seconds. Overrides the derived default when set. */
  deadline?: bigint;
}

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
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * Sleep for `ms`, rejecting early with the signal's reason if it aborts mid-wait.
 * Used by the poll loops so a cancellation is honored without waiting out the
 * current interval.
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
 * Resolve the fetch implementation: the injected one if given, else the global
 * `fetch` wrapped to the injectable shape, else throw (never silently no-op).
 */
export function resolveFetch(injected?: FetchLike): FetchLike {
  if (injected) return injected;
  if (typeof globalThis.fetch === "function") {
    return (url, init) =>
      globalThis.fetch(url, {
        method: init.method,
        body: init.body,
        headers: init.headers,
        signal: init.signal,
      });
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
 * `POST {relayerUrl}/blob/{intentId}` with the bytes as the raw body. Throws a
 * {@link RelayerUploadError} carrying the relayer's reason on any non-2xx. Shared
 * by every chain client.
 */
export async function uploadBlob(
  fetchFn: FetchLike,
  relayerUrl: string,
  intentId: Hex,
  data: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetchFn(`${relayerUrl}/blob/${intentId}`, {
    method: "POST",
    body: data,
    headers: { "content-type": "application/octet-stream" },
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
