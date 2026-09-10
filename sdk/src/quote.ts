/**
 * Priced-quote client (chain-agnostic).
 *
 * Off-chain quoting is done by the relayer, which is the single pricing source
 * of truth (contracts hold no oracle). This calls the relayer `/quote` endpoint
 * and returns a typed quote: a single origin-native amount plus a full USD
 * breakdown. Bigint amounts cross the wire as decimal strings and are parsed
 * back to `bigint` here so no precision is lost.
 */
import { resolveFetch, type FetchLike } from "./store-flow.js";
import { BosphorError } from "./errors.js";

export type OriginToken = "ETH" | "SOL";

export interface QuoteRequest {
  /** Blob size in bytes. */
  sizeBytes: number;
  /** Storage epochs (relayer default if omitted). */
  epochs?: number;
  /** Origin chain native token. */
  originToken: OriginToken;
  /** Forward LZ nativeFee (origin smallest unit), from the on-chain adapter quote. */
  forwardLzFeeNative?: bigint;
  /** Origin tx gas (origin smallest unit). */
  originGasNative?: bigint;
}

export interface QuoteBreakdown {
  walCostUsd: number;
  returnLzUsd: number;
  suiGasUsd: number;
  forwardLzUsd: number;
  originGasUsd: number;
  bufferedEscrowUsd: number;
  serviceMarginUsd: number;
  escrowUsd: number;
  forwardUsd: number;
  totalUsd: number;
  floorApplied: boolean;
}

export interface PricedQuote {
  originToken: OriginToken;
  /** Relayer-fronted bucket, escrowed at submit (origin smallest unit). */
  escrowNative: bigint;
  /** User-direct bucket (forward LZ + origin gas). */
  forwardNative: bigint;
  /** escrowNative + forwardNative = msg.value at submit. */
  totalNative: bigint;
  breakdown: QuoteBreakdown;
}

export interface FetchQuoteOptions {
  /** Injected fetch (defaults to global fetch). */
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * Fetch an all-in priced quote from the relayer.
 *
 * @param relayerUrl base relayer URL (e.g. https://api.bosphor.xyz/testnet)
 * @throws BosphorError on a non-2xx response or an unparseable body
 */
export async function fetchQuote(
  relayerUrl: string,
  request: QuoteRequest,
  opts: FetchQuoteOptions = {},
): Promise<PricedQuote> {
  const fetchFn = resolveFetch(opts.fetch);
  const url = `${relayerUrl.replace(/\/+$/, "")}/quote`;
  const payload: Record<string, unknown> = {
    sizeBytes: request.sizeBytes,
    originToken: request.originToken,
  };
  if (request.epochs !== undefined) payload.epochs = request.epochs;
  if (request.forwardLzFeeNative !== undefined)
    payload.forwardLzFeeNative = request.forwardLzFeeNative.toString();
  if (request.originGasNative !== undefined)
    payload.originGasNative = request.originGasNative.toString();

  const init = {
    method: "POST",
    body: new TextEncoder().encode(JSON.stringify(payload)),
    headers: { "content-type": "application/json" },
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  const res = await fetchFn(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new BosphorError(`relayer quote failed (${res.status}): ${text}`);
  }

  let body: RawQuote;
  try {
    body = JSON.parse(text) as RawQuote;
  } catch {
    throw new BosphorError(`relayer quote returned an unparseable body: ${text}`);
  }

  return {
    originToken: body.originToken,
    escrowNative: BigInt(body.escrowNative),
    forwardNative: BigInt(body.forwardNative),
    totalNative: BigInt(body.totalNative),
    breakdown: body.breakdown,
  };
}

interface RawQuote {
  originToken: OriginToken;
  escrowNative: string;
  forwardNative: string;
  totalNative: string;
  breakdown: QuoteBreakdown;
}
