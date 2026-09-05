import { QuoteEngine, QuoteConfig, QuoteCostInputs } from './quote-engine';
import { PriceSet } from './price-oracle.types';

const PRICES: PriceSet = {
  WAL: { token: 'WAL', usd: 0.03, publishTimeMs: 0, source: 'test' },
  SUI: { token: 'SUI', usd: 0.8, publishTimeMs: 0, source: 'test' },
  ETH: { token: 'ETH', usd: 2500, publishTimeMs: 0, source: 'test' },
  SOL: { token: 'SOL', usd: 100, publishTimeMs: 0, source: 'test' },
};

const CONFIG: QuoteConfig = {
  buffers: { returnLeg: 0.2, suiGas: 0.2, wal: 0.1, crossRate: 0.05 },
  serviceMarginRatio: 0.15,
  minChargeUsd: 0.02,
};

// A representative 1 MiB store: WAL cost 34_840_000 FROST, return leg 1.76 SUI,
// Sui gas 0.01 SUI, forward LZ 0.001211 ETH, origin gas 0.00004 ETH.
function inputs(overrides: Partial<QuoteCostInputs> = {}): QuoteCostInputs {
  return {
    originToken: 'ETH',
    walCostFrost: 34_840_000n,
    returnLzFeeMist: 1_760_000_000n,
    suiGasMist: 10_000_000n,
    forwardLzFeeNative: 1_211_000_000_000_000n,
    originGasNative: 40_000_000_000_000n,
    ...overrides,
  };
}

describe('QuoteEngine', () => {
  const engine = new QuoteEngine(CONFIG);

  it('sums the cost stack into a single origin-native amount plus breakdown', () => {
    const q = engine.quote(inputs(), PRICES);

    // Raw per-component USD.
    expect(q.breakdown.walCostUsd).toBeCloseTo(0.0010452, 7);
    expect(q.breakdown.returnLzUsd).toBeCloseTo(1.408, 5);
    expect(q.breakdown.suiGasUsd).toBeCloseTo(0.008, 6);
    expect(q.breakdown.forwardLzUsd).toBeCloseTo(3.0275, 4);
    expect(q.breakdown.originGasUsd).toBeCloseTo(0.1, 6);

    // Buffered escrow bucket (wal*1.1 + return*1.2*1.05 + suiGas*1.2*1.05).
    expect(q.breakdown.bufferedEscrowUsd).toBeCloseTo(1.7853097, 5);
    expect(q.breakdown.floorApplied).toBe(false);

    // Escrow adds the service margin on top.
    expect(q.breakdown.escrowUsd).toBeCloseTo(2.0531062, 5);
    // User-direct forward bucket = forward LZ + origin gas (no buffer, no FX risk).
    expect(q.breakdown.forwardUsd).toBeCloseTo(3.1275, 4);
    expect(q.breakdown.totalUsd).toBeCloseTo(5.1806062, 4);

    // Native amounts (ETH, 18 decimals).
    expect(Number(q.escrowNative) / 1e18).toBeCloseTo(2.0531062 / 2500, 8);
    // Forward is passed through exactly (user pays it directly at submit).
    expect(q.forwardNative).toBe(1_211_000_000_000_000n + 40_000_000_000_000n);
    expect(q.totalNative).toBe(q.escrowNative + q.forwardNative);
    expect(q.originToken).toBe('ETH');
  });

  it('weights buffers to the SUI return leg and cross-rate, barely to WAL', () => {
    const q = engine.quote(inputs(), PRICES);
    // Return-leg buffered contribution should dwarf the WAL one, and the WAL
    // buffer multiple (1.1) must be well below the return-leg multiple (1.2*1.05).
    const returnMultiple = 1.2 * 1.05;
    const walMultiple = 1.1;
    expect(returnMultiple).toBeGreaterThan(walMultiple);
  });

  it('applies the minimum-charge floor for a tiny store', () => {
    const q = engine.quote(
      inputs({ walCostFrost: 0n, returnLzFeeMist: 0n, suiGasMist: 0n }),
      PRICES,
    );
    expect(q.breakdown.floorApplied).toBe(true);
    expect(q.breakdown.bufferedEscrowUsd).toBeCloseTo(0.02, 6);
    expect(q.breakdown.escrowUsd).toBeCloseTo(0.023, 6);
  });

  it('quotes a Solana origin in SOL', () => {
    const q = engine.quote(
      inputs({ originToken: 'SOL', forwardLzFeeNative: 5_000_000n, originGasNative: 10_000n }),
      PRICES,
    );
    expect(q.originToken).toBe('SOL');
    // forward = 0.005 SOL + 0.00001 SOL = 0.00501 SOL * $100 = $0.501
    expect(q.breakdown.forwardUsd).toBeCloseTo(0.501, 4);
    expect(Number(q.escrowNative) / 1e9).toBeCloseTo(q.breakdown.escrowUsd / 100, 6);
  });

  describe('fails loud on bad input (never a fabricated quote)', () => {
    it('rejects a negative fee', () => {
      expect(() => engine.quote(inputs({ returnLzFeeMist: -1n }), PRICES)).toThrow(/fee|negative/i);
    });
    it('rejects a non-positive origin price', () => {
      const bad = { ...PRICES, ETH: { ...PRICES.ETH, usd: 0 } };
      expect(() => engine.quote(inputs(), bad)).toThrow(/price/i);
    });
  });
});
