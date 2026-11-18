/**
 * Blob-id derivation through the relayer's encode-only endpoint.
 *
 * `POST {relayerUrl}/blob/encode` runs the same `@mysten/walrus` encoder the
 * relayer uses to verify an upload, and returns the Walrus blob id without
 * storing anything. A browser dApp uses it instead of bundling the Walrus WASM
 * encoder. It is safe to trust: the relayer recomputes the id from the uploaded
 * bytes and rejects a mismatch, so a wrong id can never be stored.
 */

import type { BlobEncoding, ComputeBlob } from "./types.js";
import { base64UrlToBytes32Hex, createDefaultComputeBlob, type WalrusNetwork } from "./blob.js";
import { BosphorError, RelayerRequestError } from "./errors.js";
import { readRetryAfterMs, withRelayerRetry, type RetryPolicy } from "./relayer-http.js";
import {
  isTransientRpcError,
  relayerHeaders,
  resolveFetch,
  validateAppId,
  type FetchLike,
} from "./store-flow.js";

/**
 * Largest blob the hosted relayers encode or ingest (10 MiB, the relayer's
 * `MAX_INGEST_BLOB_BYTES`). Larger bodies are refused with a 413.
 */
export const MAX_RELAYER_ENCODE_BYTES: number = 10 * 1024 * 1024;

/** Default retry bounds of the encode call: transient errors only, within 30s. */
const DEFAULT_ENCODE_RETRY: Required<RetryPolicy> = {
  maxAttempts: 4,
  maxElapsedMs: 30_000,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
};

/** Options for {@link relayerComputeBlob}. */
export interface RelayerComputeBlobOptions {
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Integrator app id, sent as the `X-Bosphor-App` header (attribution only). */
  appId?: string;
  /**
   * Refuse larger blobs locally instead of sending them. Defaults to
   * {@link MAX_RELAYER_ENCODE_BYTES}; raise it only for a self-hosted relayer
   * configured with a bigger `MAX_INGEST_BLOB_BYTES`.
   */
  maxBytes?: number;
  /**
   * Retry bounds for 408, 429, 5xx and network errors, or `false` for a single
   * attempt. `/blob/encode` is rate limited per IP (30 per minute on the hosted
   * relayers); a `Retry-After` longer than the budget fails right away with a
   * {@link RelayerRequestError} whose `retryAfterMs` says how long to wait.
   */
  retry?: RetryPolicy | false;
}

/**
 * How a client derives blob ids: a custom {@link ComputeBlob}, or `"relayer"` for
 * {@link relayerComputeBlob} against the client's own relayer (browser friendly),
 * or `"local"` for the `@mysten/walrus` WASM encoder (the default).
 */
export type ComputeBlobOption = ComputeBlob | "relayer" | "local";

/**
 * Resolve a client's `computeBlob` option. Shared by the chain clients so
 * `"relayer"` means the same thing everywhere: the client's relayer, fetch and
 * app id.
 */
export function resolveComputeBlob(
  option: ComputeBlobOption | undefined,
  ctx: { network: WalrusNetwork; relayerUrl: string; fetch?: FetchLike | undefined; appId?: string | undefined },
): ComputeBlob {
  if (typeof option === "function") return option;
  if (option === "relayer") {
    const o: RelayerComputeBlobOptions = {};
    if (ctx.fetch) o.fetch = ctx.fetch;
    if (ctx.appId) o.appId = ctx.appId;
    return relayerComputeBlob(ctx.relayerUrl, o);
  }
  if (option === undefined || option === "local") return createDefaultComputeBlob(ctx.network);
  throw new Error(`unknown computeBlob option: ${String(option)}`);
}

/**
 * Build a {@link ComputeBlob} that derives the Walrus blob id through the
 * relayer's `POST /blob/encode` instead of the local `@mysten/walrus` WASM
 * encoder. It returns the same {@link BlobEncoding} as the local encoder, byte
 * for byte, and needs no Walrus SDK, no WASM and no Sui RPC, so it is the
 * natural choice in a browser. The client factories accept `computeBlob:
 * "relayer"` as a shortcut for it.
 *
 * The file bytes are sent to the relayer to be encoded (nothing is stored).
 *
 * @param relayerUrl Base relayer URL, for example `TESTNET.relayerUrl`. Use the
 *   relayer of the same network as the client: the blob id depends on the Walrus
 *   network.
 * @param opts Injected fetch, app id, size cap and retry bounds.
 * @throws {@link RelayerRequestError} when the relayer answers non-2xx (with
 *   `retryAfterMs` on a 429); an `Error` on empty or oversized data or a
 *   malformed answer. Never returns a made up id.
 *
 * @example
 * ```ts
 * import { TESTNET, relayerComputeBlob } from "@bosphor/sdk";
 *
 * const computeBlob = relayerComputeBlob(TESTNET.relayerUrl, { appId: "my-dapp" });
 * const { blobId, size } = await computeBlob(bytes);
 * ```
 */
export function relayerComputeBlob(
  relayerUrl: string,
  opts: RelayerComputeBlobOptions = {},
): ComputeBlob {
  const appId = validateAppId(opts.appId);
  const maxBytes = opts.maxBytes ?? MAX_RELAYER_ENCODE_BYTES;
  const url = `${relayerUrl.replace(/\/+$/, "")}/blob/encode`;

  return async (data, callOpts = {}): Promise<BlobEncoding> => {
    const signal = callOpts.signal;
    signal?.throwIfAborted();
    if (data.length === 0) throw new Error("cannot encode empty data");
    if (data.length > maxBytes) {
      throw new Error(
        `blob is ${data.length} bytes, over the relayer encode limit of ${maxBytes} bytes`,
      );
    }
    // Resolved per call so a page that polyfills fetch after import still works.
    const fetchFn = resolveFetch(opts.fetch);

    const attempt = async (): Promise<string> => {
      const res = await fetchFn(url, {
        method: "POST",
        body: data,
        headers: relayerHeaders("application/octet-stream", appId),
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new RelayerRequestError("blob encode", res.status, text, readRetryAfterMs(res));
      }
      return text;
    };

    const text =
      opts.retry === false
        ? await attempt()
        : await withRelayerRetry(attempt, {
            ...DEFAULT_ENCODE_RETRY,
            ...(opts.retry ?? {}),
            signal,
            shouldRetry: (err) =>
              err instanceof RelayerRequestError ? err.retryable : isTransientRpcError(err),
          });

    let body: { blobId?: unknown; size?: unknown };
    try {
      body = JSON.parse(text) as { blobId?: unknown; size?: unknown };
    } catch {
      throw new BosphorError(`relayer blob encode returned an unparseable body: ${text}`);
    }
    if (typeof body.blobId !== "string") {
      throw new BosphorError(`relayer blob encode returned no blobId: ${text}`);
    }
    if (body.size !== data.length) {
      throw new BosphorError(
        `relayer blob encode reported size ${String(body.size)} but data is ${data.length} bytes`,
      );
    }
    return {
      blobId: base64UrlToBytes32Hex(body.blobId),
      size: data.length,
      // Walrus RedStuff is encoding type 0 (the only Walrus encoding today).
      encodingType: 0,
    };
  };
}
