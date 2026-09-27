/**
 * The live Solana -> Sui LayerZero fee, from the relayer (`GET /lz-fee/solana`)
 * or locally with the LayerZero Solana SDK, and the order the SDK tries them in.
 *
 * The relayer simulates the same endpoint `quote` instruction as
 * {@link quoteSolanaLzFee}, so a browser gets an exact fee without bundling the
 * heavy `@layerzerolabs/lz-solana-sdk-v2`.
 */

import { TESTNET, type BosphorNetwork } from "../networks.js";
import { BosphorError, RelayerRequestError } from "../errors.js";
import { readRetryAfterMs } from "../relayer-http.js";
import { relayerHeaders, resolveFetch, validateAppId, type FetchLike } from "../store-flow.js";
import { LzSolanaSdkMissingError, quoteSolanaLzFee, type QuoteSolanaLzFeeOptions } from "./lz-fee.js";

/** Options for {@link fetchSolanaLzFee}. */
export interface FetchSolanaLzFeeOptions {
  /** Network preset whose pathway is priced; defaults to {@link TESTNET}. */
  network?: BosphorNetwork;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Cancel the request. */
  signal?: AbortSignal;
  /** Integrator app id, sent as `X-Bosphor-App` (attribution only). */
  appId?: string;
}

/**
 * Read the live LayerZero fee (lamports) for one Bosphor forward message from
 * Solana to Sui from the relayer's `GET /lz-fee/solana`. The relayer computes it
 * server-side and caches it for about 30 seconds.
 *
 * @param relayerUrl Base relayer URL, for example `TESTNET.relayerUrl`.
 * @throws {@link RelayerRequestError} on a non-2xx answer: `404` from a relayer
 *   that predates the endpoint, `501` when it serves no Solana origin, `503`
 *   (retryable, with `retryAfterMs`) when the simulation failed.
 * @throws {@link BosphorError} if the answer is for another pathway or malformed.
 *
 * @example
 * ```ts
 * import { TESTNET, fetchSolanaLzFee } from "@bosphor/sdk/solana";
 *
 * const lamports = await fetchSolanaLzFee(TESTNET.relayerUrl);
 * ```
 */
export async function fetchSolanaLzFee(
  relayerUrl: string,
  opts: FetchSolanaLzFeeOptions = {},
): Promise<bigint> {
  const network = opts.network ?? TESTNET;
  const appId = validateAppId(opts.appId);
  const fetchFn = resolveFetch(opts.fetch);
  const url = `${relayerUrl.replace(/\/+$/, "")}/lz-fee/solana?dstEid=${network.sui.eid}`;
  const headers = relayerHeaders("application/json", appId);
  // A GET has no body; only ask for JSON.
  delete headers["content-type"];
  headers.accept = "application/json";

  const res = await fetchFn(url, { method: "GET", headers, signal: opts.signal });
  const text = await res.text();
  if (!res.ok) {
    throw new RelayerRequestError("Solana LayerZero fee", res.status, text, readRetryAfterMs(res));
  }
  let body: { srcEid?: unknown; dstEid?: unknown; nativeFee?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new BosphorError(`relayer Solana LayerZero fee returned an unparseable body: ${text}`);
  }
  if (body.srcEid !== network.solana.eid || body.dstEid !== network.sui.eid) {
    throw new BosphorError(
      `relayer quoted the pathway ${String(body.srcEid)} -> ${String(body.dstEid)}, ` +
        `expected ${network.solana.eid} -> ${network.sui.eid}: is it the relayer of this network?`,
    );
  }
  if (typeof body.nativeFee !== "string" || !/^\d+$/.test(body.nativeFee)) {
    throw new BosphorError(`relayer returned a malformed nativeFee: ${text}`);
  }
  return BigInt(body.nativeFee);
}

/** Where {@link resolveSolanaLzFee} may look for the live fee. */
export interface ResolveSolanaLzFeeOptions {
  network: BosphorNetwork;
  /** A `Connection` for the local quote; without it the local quote is skipped. */
  connection?: object | undefined;
  lzSdk?: object | undefined;
  web3?: object | undefined;
  /** The relayer to ask when the local quote is unavailable, or `false` to skip it. */
  relayer?:
    | { url: string; fetch?: FetchLike | undefined; signal?: AbortSignal | undefined; appId?: string | undefined }
    | false
    | undefined;
}

/**
 * The live Solana LayerZero fee, or `null` when no live source is available (the
 * caller then prices the preset cap and flags `forwardIsUpperBound`). Order:
 *
 *  1. locally, with `@layerzerolabs/lz-solana-sdk-v2` (when installed and a
 *     connection is given);
 *  2. from the relayer's `GET /lz-fee/solana` (browsers, or no LZ SDK);
 *  3. `null`, only when the relayer does not offer the endpoint (404, 501).
 *
 * Any other failure (RPC, simulation, a relayer 503) is thrown: a made up fee is
 * never returned.
 */
export async function resolveSolanaLzFee(opts: ResolveSolanaLzFeeOptions): Promise<bigint | null> {
  if (opts.connection) {
    try {
      const feeOpts: QuoteSolanaLzFeeOptions = { connection: opts.connection, network: opts.network };
      if (opts.lzSdk) feeOpts.lzSdk = opts.lzSdk;
      if (opts.web3) feeOpts.web3 = opts.web3;
      return await quoteSolanaLzFee(feeOpts);
    } catch (err) {
      if (!(err instanceof LzSolanaSdkMissingError)) throw err;
    }
  }
  if (!opts.relayer) return null;
  try {
    const r = opts.relayer;
    const fetchOpts: FetchSolanaLzFeeOptions = { network: opts.network };
    if (r.fetch) fetchOpts.fetch = r.fetch;
    if (r.signal) fetchOpts.signal = r.signal;
    if (r.appId) fetchOpts.appId = r.appId;
    return await fetchSolanaLzFee(r.url, fetchOpts);
  } catch (err) {
    if (err instanceof RelayerRequestError && (err.status === 404 || err.status === 501)) return null;
    throw err;
  }
}
