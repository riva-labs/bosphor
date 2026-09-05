import { PriceOracle } from './price-oracle';
import { FetchFn, PriceOracleConfig } from './price-oracle.types';
import hermesFixture from './fixtures/hermes-latest.json';
import coingeckoFixture from './fixtures/coingecko-simple-price.json';

// Fixture prices are stamped at this unix second; the test clock sits just after.
const PUBLISH_MS = 1757030400 * 1000;
const NOW_MS = PUBLISH_MS + 5_000;

function baseConfig(overrides: Partial<PriceOracleConfig> = {}): PriceOracleConfig {
  return {
    maxStalenessMs: 60_000,
    maxDeviationRatio: 0.1,
    sanityBounds: {
      WAL: { min: 0.0001, max: 100 },
      SUI: { min: 0.01, max: 1000 },
      ETH: { min: 10, max: 1_000_000 },
      SOL: { min: 1, max: 100_000 },
    },
    pyth: {
      url: 'https://hermes.example/v2/updates/price/latest',
      feedIds: {
        WAL: 'eba0732395fae9dec4bae12e52760b35fc1c5671e2da8b449c9af4efe5d54341',
        SUI: '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
        ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
        SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
      },
    },
    coingecko: {
      url: 'https://api.coingecko.example/api/v3/simple/price',
      ids: { WAL: 'walrus-2', SUI: 'sui', ETH: 'ethereum', SOL: 'solana' },
    },
    nowMs: () => NOW_MS,
    ...overrides,
  };
}

/** Route by URL substring: 'hermes' -> Pyth, else CoinGecko. */
function makeFetch(opts: {
  hermes?: unknown;
  hermesFail?: boolean;
  coingecko?: unknown;
  coingeckoFail?: boolean;
}): FetchFn {
  return async (url: string) => {
    const isHermes = url.includes('hermes');
    if (isHermes) {
      if (opts.hermesFail) return { ok: false, status: 401, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => opts.hermes ?? hermesFixture };
    }
    if (opts.coingeckoFail) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => opts.coingecko ?? coingeckoFixture };
  };
}

describe('PriceOracle', () => {
  it('returns USD prices for all four tokens from the primary (Pyth)', async () => {
    const oracle = new PriceOracle(baseConfig(), makeFetch({}));
    const prices = await oracle.getPrices();

    expect(prices.WAL.usd).toBeCloseTo(0.0269, 6);
    expect(prices.SUI.usd).toBeCloseTo(0.786, 6);
    expect(prices.ETH.usd).toBeCloseTo(2458.69, 2);
    expect(prices.SOL.usd).toBeCloseTo(102.54, 2);
    expect(prices.WAL.source).toBe('pyth');
  });

  it('falls back to CoinGecko when the primary fails', async () => {
    const oracle = new PriceOracle(baseConfig(), makeFetch({ hermesFail: true }));
    const prices = await oracle.getPrices();

    expect(prices.WAL.source).toBe('coingecko');
    expect(prices.WAL.usd).toBeCloseTo(0.0271, 6);
    expect(prices.ETH.usd).toBeCloseTo(2461.1, 2);
  });

  it('rejects prices older than the staleness bound (fails loud)', async () => {
    const stale = baseConfig({ nowMs: () => PUBLISH_MS + 10 * 60_000 });
    const oracle = new PriceOracle(stale, makeFetch({ hermesFail: true }));
    // Only CoinGecko is available and it is stale -> no fresh source -> throw.
    await expect(oracle.getPrices()).rejects.toThrow(/stale/i);
  });

  it('rejects a price that deviates implausibly from the cross-source consensus', async () => {
    // CoinGecko reports WAL at $5 vs Pyth $0.0269 -> way beyond 10% -> reject.
    const badCg = {
      ...(coingeckoFixture as Record<string, unknown>),
      'walrus-2': { usd: 5, last_updated_at: 1757030400 },
    };
    const oracle = new PriceOracle(baseConfig(), makeFetch({ coingecko: badCg }));
    await expect(oracle.getPrices()).rejects.toThrow(/deviat/i);
  });

  it('rejects a price outside the absolute sanity bounds', async () => {
    // Both sources agree on an absurd ETH price below the min bound.
    const badHermes = {
      parsed: (hermesFixture as { parsed: any[] }).parsed.map((p) =>
        p.id.startsWith('ff614')
          ? { ...p, price: { ...p.price, price: '100000000' } } // $1.00
          : p,
      ),
    };
    const badCg = {
      ...(coingeckoFixture as Record<string, unknown>),
      ethereum: { usd: 1.0, last_updated_at: 1757030400 },
    };
    const oracle = new PriceOracle(baseConfig(), makeFetch({ hermes: badHermes, coingecko: badCg }));
    await expect(oracle.getPrices()).rejects.toThrow(/sanity|bound/i);
  });

  it('fails loud when every source fails (never fabricates a value)', async () => {
    const oracle = new PriceOracle(
      baseConfig(),
      makeFetch({ hermesFail: true, coingeckoFail: true }),
    );
    await expect(oracle.getPrices()).rejects.toThrow();
  });

  it('sends the Pyth API key as a header when configured', async () => {
    const seen: Record<string, string>[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      if (url.includes('hermes')) seen.push(init?.headers ?? {});
      return { ok: true, status: 200, json: async () => hermesFixture };
    };
    const oracle = new PriceOracle(
      baseConfig({ pyth: { ...baseConfig().pyth, apiKey: 'secret-key' } }),
      fetchFn,
    );
    await oracle.getPrices();
    expect(JSON.stringify(seen)).toContain('secret-key');
  });
});
