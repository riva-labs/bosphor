import { evaluateBreakEven, BreakEvenInputs } from './break-even-guard';
import { PriceSet } from './price-oracle.types';

const PRICES: PriceSet = {
  WAL: { token: 'WAL', usd: 0.03, publishTimeMs: 0, source: 'test' },
  SUI: { token: 'SUI', usd: 0.8, publishTimeMs: 0, source: 'test' },
  ETH: { token: 'ETH', usd: 2500, publishTimeMs: 0, source: 'test' },
  SOL: { token: 'SOL', usd: 100, publishTimeMs: 0, source: 'test' },
};

// Actual relayer-fronted cost for a 1 MiB store: WAL 0.001045, return 1.408,
// sui gas 0.008 -> ~$1.417 USD.
function inputs(overrides: Partial<BreakEvenInputs> = {}): BreakEvenInputs {
  return {
    escrowNative: 800_000_000_000_000n, // 0.0008 ETH = $2.00
    originToken: 'ETH',
    walCostFrost: 34_840_000n,
    returnLzFeeMist: 1_760_000_000n,
    suiGasMist: 10_000_000n,
    minMarginRatio: 0.1,
    prices: PRICES,
    ...overrides,
  };
}

describe('evaluateBreakEven', () => {
  it('proceeds when escrow covers cost plus the minimum margin', () => {
    const d = evaluateBreakEven(inputs());
    expect(d.costUsd).toBeCloseTo(1.4170452, 4);
    expect(d.escrowUsd).toBeCloseTo(2.0, 6);
    expect(d.proceed).toBe(true);
    expect(d.marginUsd).toBeGreaterThan(0);
  });

  it('skips when escrow is below cost + margin (adverse case)', () => {
    // Escrow only $1.45, just above raw cost $1.417 but below cost*1.1 = $1.559.
    const d = evaluateBreakEven(inputs({ escrowNative: 580_000_000_000_000n }));
    expect(d.escrowUsd).toBeCloseTo(1.45, 4);
    expect(d.requiredUsd).toBeCloseTo(1.5587497, 4);
    expect(d.proceed).toBe(false);
    expect(d.reason).toMatch(/SKIP/);
  });

  it('skips when the return-leg (SUI) cost spikes mid-flight', () => {
    // Same escrow, but the SUI return fee doubles -> cost jumps past escrow.
    const d = evaluateBreakEven(inputs({ returnLzFeeMist: 4_000_000_000n }));
    expect(d.proceed).toBe(false);
  });

  it('skips when the origin native (ETH) price drops, shrinking escrow value', () => {
    const cheapEth = { ...PRICES, ETH: { ...PRICES.ETH, usd: 1500 } };
    // 0.0008 ETH now worth $1.20 < cost -> skip.
    const d = evaluateBreakEven(inputs({ prices: cheapEth }));
    expect(d.escrowUsd).toBeCloseTo(1.2, 4);
    expect(d.proceed).toBe(false);
  });

  it('treats a zero-cost store as infinite margin (proceeds)', () => {
    const d = evaluateBreakEven(
      inputs({ walCostFrost: 0n, returnLzFeeMist: 0n, suiGasMist: 0n }),
    );
    expect(d.costUsd).toBe(0);
    expect(d.marginRatio).toBe(Number.POSITIVE_INFINITY);
    expect(d.proceed).toBe(true);
  });

  it('fails loud on a missing price (never guesses)', () => {
    const bad = { ...PRICES, SUI: { ...PRICES.SUI, usd: 0 } };
    expect(() => evaluateBreakEven(inputs({ prices: bad }))).toThrow(/SUI price/);
  });
});
