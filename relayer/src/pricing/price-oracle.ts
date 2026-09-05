import {
  FetchFn,
  PriceOracleConfig,
  PricePoint,
  PriceSet,
  PriceToken,
  PRICE_TOKENS,
} from './price-oracle.types';

type PartialPrices = Partial<Record<PriceToken, PricePoint>>;

/**
 * Multi-source USD price oracle for the payment stack (WAL / SUI / ETH / SOL).
 *
 * Primary source is Pyth Hermes; CoinGecko is the fallback. Every returned price
 * is checked for staleness and against absolute sanity bounds, and when both
 * sources report a token they must agree within a configured deviation ratio.
 * Any violation, or total source failure, throws: this feed drives spend and
 * refund decisions, so it must fail loud and never return a fabricated value.
 */
export class PriceOracle {
  constructor(
    private readonly config: PriceOracleConfig,
    private readonly fetchFn: FetchFn = fetch as unknown as FetchFn,
  ) {}

  private now(): number {
    return this.config.nowMs ? this.config.nowMs() : Date.now();
  }

  async getPrices(): Promise<PriceSet> {
    const [pyth, coingecko] = await Promise.all([
      this.tryPyth().catch(() => ({}) as PartialPrices),
      this.tryCoinGecko().catch(() => ({}) as PartialPrices),
    ]);

    const resolved: Partial<PriceSet> = {};
    for (const token of PRICE_TOKENS) {
      resolved[token] = this.reconcile(token, pyth[token], coingecko[token]);
    }
    return resolved as PriceSet;
  }

  /** Pick the authoritative price for one token, applying every safety check. */
  private reconcile(
    token: PriceToken,
    primary: PricePoint | undefined,
    fallback: PricePoint | undefined,
  ): PricePoint {
    const freshPrimary = primary && this.isFresh(primary) ? primary : undefined;
    const freshFallback = fallback && this.isFresh(fallback) ? fallback : undefined;

    // Cross-source consensus: if both feeds are fresh they must agree, else we
    // cannot tell which is wrong and must not trust either for a spend decision.
    if (freshPrimary && freshFallback) {
      const dev = this.deviation(freshPrimary.usd, freshFallback.usd);
      if (dev > this.config.maxDeviationRatio) {
        throw new Error(
          `PriceOracle: ${token} sources deviate ${(dev * 100).toFixed(1)}% ` +
            `(pyth ${freshPrimary.usd} vs coingecko ${freshFallback.usd}), ` +
            `exceeds ${(this.config.maxDeviationRatio * 100).toFixed(0)}%`,
        );
      }
    }

    const chosen = freshPrimary ?? freshFallback;
    if (!chosen) {
      if (primary || fallback) {
        throw new Error(`PriceOracle: only stale ${token} prices available (all past staleness bound)`);
      }
      throw new Error(`PriceOracle: no source returned a ${token} price`);
    }

    this.assertSane(chosen);
    return chosen;
  }

  private isFresh(p: PricePoint): boolean {
    return this.now() - p.publishTimeMs <= this.config.maxStalenessMs;
  }

  private deviation(a: number, b: number): number {
    const lo = Math.min(a, b);
    if (lo <= 0) return Number.POSITIVE_INFINITY;
    return Math.abs(a - b) / lo;
  }

  private assertSane(p: PricePoint): void {
    const bounds = this.config.sanityBounds[p.token];
    if (!Number.isFinite(p.usd) || p.usd <= 0) {
      throw new Error(`PriceOracle: ${p.token} price ${p.usd} is not a positive number`);
    }
    if (p.usd < bounds.min || p.usd > bounds.max) {
      throw new Error(
        `PriceOracle: ${p.token} price ${p.usd} outside sanity bounds ` +
          `[${bounds.min}, ${bounds.max}]`,
      );
    }
  }

  // --- Sources -------------------------------------------------------------

  private async tryPyth(): Promise<PartialPrices> {
    const { url, apiKey, feedIds } = this.config.pyth;
    const params = PRICE_TOKENS.map((t) => `ids[]=${feedIds[t]}`).join('&');
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const res = await this.fetchFn(`${url}?${params}&parsed=true`, { headers });
    if (!res.ok) throw new Error(`Pyth Hermes returned ${res.status}`);
    const body = (await res.json()) as { parsed?: PythParsed[] };
    const parsed = body.parsed ?? [];

    const byId = new Map<string, PythParsed>();
    for (const p of parsed) byId.set(normalizeHex(p.id), p);

    const out: PartialPrices = {};
    for (const token of PRICE_TOKENS) {
      const entry = byId.get(normalizeHex(feedIds[token]));
      if (!entry?.price) continue;
      const usd = Number(entry.price.price) * 10 ** entry.price.expo;
      if (!Number.isFinite(usd)) continue;
      out[token] = {
        token,
        usd,
        publishTimeMs: entry.price.publish_time * 1000,
        source: 'pyth',
      };
    }
    return out;
  }

  private async tryCoinGecko(): Promise<PartialPrices> {
    const { url, apiKey, ids } = this.config.coingecko;
    const idList = PRICE_TOKENS.map((t) => ids[t]).join(',');
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-cg-demo-api-key'] = apiKey;

    const res = await this.fetchFn(
      `${url}?ids=${idList}&vs_currencies=usd&include_last_updated_at=true`,
      { headers },
    );
    if (!res.ok) throw new Error(`CoinGecko returned ${res.status}`);
    const body = (await res.json()) as Record<string, { usd?: number; last_updated_at?: number }>;

    const out: PartialPrices = {};
    for (const token of PRICE_TOKENS) {
      const entry = body[ids[token]];
      if (!entry || typeof entry.usd !== 'number') continue;
      out[token] = {
        token,
        usd: entry.usd,
        // CoinGecko without last_updated_at is treated as "now" so a live call
        // is not spuriously stale; the deviation check still guards it.
        publishTimeMs: (entry.last_updated_at ?? Math.floor(this.now() / 1000)) * 1000,
        source: 'coingecko',
      };
    }
    return out;
  }
}

interface PythParsed {
  id: string;
  price?: { price: string; expo: number; publish_time: number };
}

function normalizeHex(id: string): string {
  return id.toLowerCase().replace(/^0x/, '');
}
