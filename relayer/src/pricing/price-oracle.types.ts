/** Tokens the payment stack needs USD prices for. */
export type PriceToken = 'WAL' | 'SUI' | 'ETH' | 'SOL';

export const PRICE_TOKENS: readonly PriceToken[] = ['WAL', 'SUI', 'ETH', 'SOL'];

/** A single USD price observation from one source. */
export interface PricePoint {
  token: PriceToken;
  /** USD price. */
  usd: number;
  /** Publish/observation time in epoch milliseconds. */
  publishTimeMs: number;
  /** Which source produced it (e.g. 'pyth', 'coingecko'). */
  source: string;
}

/** The full resolved price set the quote/guard consume. */
export type PriceSet = Record<PriceToken, PricePoint>;

/** Absolute plausibility bounds per token (USD). */
export type SanityBounds = Record<PriceToken, { min: number; max: number }>;

export interface PythSourceConfig {
  /** Hermes latest-price endpoint, e.g. https://hermes.pyth.network/v2/updates/price/latest */
  url: string;
  /** Optional API key (public Hermes now 401s without one). */
  apiKey?: string;
  /** Chain-agnostic Pyth feed id per token (hex, no 0x). */
  feedIds: Record<PriceToken, string>;
}

export interface CoinGeckoSourceConfig {
  /** simple/price endpoint, e.g. https://api.coingecko.com/api/v3/simple/price */
  url: string;
  /** Optional demo/pro API key. */
  apiKey?: string;
  /** CoinGecko coin id per token (e.g. WAL -> walrus-2). */
  ids: Record<PriceToken, string>;
}

export interface PriceOracleConfig {
  /** Reject any price older than this many ms. */
  maxStalenessMs: number;
  /**
   * When two sources agree on a token, reject if they differ by more than this
   * ratio (e.g. 0.1 = 10%). We cannot tell which feed is wrong, so we fail loud
   * rather than trust a single feed for a spend/refund decision.
   */
  maxDeviationRatio: number;
  /** Absolute plausibility bounds; a value outside is rejected. */
  sanityBounds: SanityBounds;
  pyth: PythSourceConfig;
  coingecko: CoinGeckoSourceConfig;
  /** Injectable clock (ms) for deterministic staleness in tests. */
  nowMs?: () => number;
}

/** Minimal fetch surface so tests can inject fixtures. */
export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;
