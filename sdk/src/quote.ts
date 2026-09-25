/**
 * Priced-quote client (chain-agnostic).
 *
 * Off-chain quoting is done by the relayer, which is the single pricing source
 * of truth (contracts hold no oracle). This calls the relayer `/quote` endpoint
 * and returns a typed quote: a single origin-native amount plus a full USD
 * breakdown. Bigint amounts cross the wire as decimal strings and are parsed
 * back to `bigint` here so no precision is lost.
 */
import { relayerHeaders, resolveFetch, validateAppId, type FetchLike } from "./store-flow.js";
import { BosphorError } from "./errors.js";

/** Native token of the origin chain the user pays in: `"ETH"` (EVM) or `"SOL"` (Solana). */
export type OriginToken = "ETH" | "SOL";

/** The request body of the relayer `POST /quote` endpoint, passed to {@link fetchQuote}. */
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

/**
 * Every cost component of a {@link PricedQuote}, in USD at the prices the relayer
 * quoted with. The escrowed bucket is `bufferedEscrowUsd + serviceMarginUsd`; the
 * user-direct bucket is `forwardLzUsd + originGasUsd`.
 */
export interface QuoteBreakdown {
  /** Walrus storage cost (WAL) for the blob size and epochs. */
  walCostUsd: number;
  /** LayerZero fee of the return leg that carries the proof back to the origin chain. */
  returnLzUsd: number;
  /** Sui gas for executing the store on Sui. */
  suiGasUsd: number;
  /** LayerZero fee of the forward leg (origin chain to Sui), paid directly by the user. */
  forwardLzUsd: number;
  /** Origin-chain transaction gas, paid directly by the user. */
  originGasUsd: number;
  /** Relayer-fronted costs (WAL, Sui gas, return leg) with price buffers, after the minimum-charge floor. */
  bufferedEscrowUsd: number;
  /** The relayer's service margin on top of `bufferedEscrowUsd`. */
  serviceMarginUsd: number;
  /** Escrowed amount: `bufferedEscrowUsd + serviceMarginUsd`. */
  escrowUsd: number;
  /** User-direct amount: `forwardLzUsd + originGasUsd`. */
  forwardUsd: number;
  /** Everything the user pays: `escrowUsd + forwardUsd`. */
  totalUsd: number;
  /** True when the minimum charge applied because the buffered costs were below it. */
  floorApplied: boolean;
}

/**
 * An all-in price for one store, returned by {@link fetchQuote} and by the chain
 * clients' `priceQuote()` and `storePriced()`. Amounts are in the origin chain's
 * smallest unit (wei or lamports).
 */
export interface PricedQuote {
  /** The token the amounts are denominated in. */
  originToken: OriginToken;
  /** Relayer-fronted bucket, escrowed at submit (origin smallest unit). */
  escrowNative: bigint;
  /** User-direct bucket (forward LZ + origin gas). */
  forwardNative: bigint;
  /** escrowNative + forwardNative = msg.value at submit. */
  totalNative: bigint;
  /**
   * True when `forwardNative` is a fee CAP rather than the live LayerZero fee (the
   * Solana client without a live fee quoter). The amount actually charged is then
   * lower: `escrowNative` plus the live fee, which is at most `forwardNative`.
   */
  forwardIsUpperBound: boolean;
  /** Every cost component in USD. */
  breakdown: QuoteBreakdown;
}

/** The file to price: its bytes, or just its size. */
export type StoreSize = { data: Uint8Array } | { sizeBytes: number };

/** Resolve the byte size from a {@link StoreSize}, rejecting empty or invalid sizes. */
export function resolveStoreSize(size: StoreSize): number {
  const n = "data" in size ? size.data.length : size.sizeBytes;
  if (!Number.isInteger(n) || n <= 0) throw new Error(`size must be a positive integer, got ${n}`);
  return n;
}

/** Options for {@link fetchQuote}. */
export interface FetchQuoteOptions {
  /** Injected fetch (defaults to global fetch). */
  fetch?: FetchLike;
  /** Cancels the request when this signal aborts. */
  signal?: AbortSignal;
  /** Integrator app id, sent as the `X-Bosphor-App` header (attribution only). */
  appId?: string;
}

/**
 * Fetch an all-in priced quote from the relayer `POST /quote` endpoint. Amounts
 * cross the wire as decimal strings and come back as `bigint`, so no precision is
 * lost. The chain clients wrap this as `priceQuote()`.
 *
 * @param relayerUrl Base relayer URL, for example `TESTNET.relayerUrl`.
 * @param request What to price: size, epochs, origin token, and the forward fees.
 * @param opts Injected fetch, abort signal, and integrator app id.
 * @returns The priced quote. Never a fabricated or fallback price.
 * @throws {@link BosphorError} on a non-2xx response or an unparseable body.
 *
 * @example
 * ```ts
 * import { fetchQuote, TESTNET } from "@bosphor/sdk";
 *
 * const quote = await fetchQuote(TESTNET.relayerUrl, { sizeBytes: 1024, originToken: "ETH" });
 * console.log(quote.totalNative, quote.breakdown.totalUsd);
 * ```
 */
export async function fetchQuote(
  relayerUrl: string,
  request: QuoteRequest,
  opts: FetchQuoteOptions = {},
): Promise<PricedQuote> {
  const fetchFn = resolveFetch(opts.fetch);
  const appId = validateAppId(opts.appId);
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
    headers: relayerHeaders("application/json", appId),
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
    forwardIsUpperBound: false,
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
