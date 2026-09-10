import { computeWalCost, WalrusSystemState } from '../walrus/wal-cost.calculator';
import { QuoteEngine, QuoteConfig, OriginToken } from './quote-engine';
import { PriceSet } from './price-oracle.types';
import { amountToUsd, FROST_DECIMALS, MIST_DECIMALS, NATIVE_DECIMALS } from './pricing-math';

/**
 * Fee-abstraction + cost-per-blob-size suite (deliverable c). Proves that the
 * single origin-native amount the user pays covers the whole downstream cost
 * stack (WAL storage + Sui gas + LayerZero return leg), across blob sizes and on
 * both EVM (ETH) and Solana (SOL) origins.
 */

const STATE: WalrusSystemState = {
  nShards: 1000,
  storagePricePerUnitSize: 100_000n,
  writePricePerUnitSize: 20_000n,
  encodingType: 'RS2',
};

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

// Relayer-fronted downstream legs (recomputed live at exec; fixed here for the sim).
const RETURN_LZ_MIST = 1_760_000_000n; // 1.76 SUI
const SUI_GAS_MIST = 10_000_000n; // 0.01 SUI
const FORWARD_LZ_ETH = 1_211_000_000_000_000n; // 0.001211 ETH (user-direct)
const FORWARD_LZ_SOL = 5_000_000n; // 0.005 SOL (user-direct)
const EPOCHS = 5;

const SIZES = [1024, 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024];

function downstreamCostUsd(walCostFrost: bigint): number {
  return (
    amountToUsd(walCostFrost, FROST_DECIMALS, PRICES.WAL.usd) +
    amountToUsd(RETURN_LZ_MIST, MIST_DECIMALS, PRICES.SUI.usd) +
    amountToUsd(SUI_GAS_MIST, MIST_DECIMALS, PRICES.SUI.usd)
  );
}

function quoteFor(size: number, originToken: OriginToken) {
  const engine = new QuoteEngine(CONFIG);
  const walCostFrost = computeWalCost(size, EPOCHS, STATE).totalCostFrost;
  const quote = engine.quote(
    {
      originToken,
      walCostFrost,
      returnLzFeeMist: RETURN_LZ_MIST,
      suiGasMist: SUI_GAS_MIST,
      forwardLzFeeNative: originToken === 'ETH' ? FORWARD_LZ_ETH : FORWARD_LZ_SOL,
      originGasNative: 0n,
    },
    PRICES,
  );
  return { quote, walCostFrost };
}

describe('fee abstraction across blob sizes', () => {
  for (const originToken of ['ETH', 'SOL'] as OriginToken[]) {
    describe(`${originToken} origin`, () => {
      it('the single escrow amount covers the full downstream cost stack', () => {
        for (const size of SIZES) {
          const { quote, walCostFrost } = quoteFor(size, originToken);
          // Escrow value in USD (what the user pays into escrow) must cover the
          // actual downstream relayer-fronted cost, with the margin on top.
          const escrowUsd = amountToUsd(
            quote.escrowNative,
            NATIVE_DECIMALS[originToken],
            PRICES[originToken].usd,
          );
          const cost = downstreamCostUsd(walCostFrost);
          expect(escrowUsd).toBeGreaterThanOrEqual(cost);
          // And the reported breakdown agrees the escrow beats cost + margin.
          expect(quote.breakdown.escrowUsd).toBeGreaterThan(cost);
        }
      });

      it('the user pays ONE origin-native amount = escrow + forward fee', () => {
        const { quote } = quoteFor(1024 * 1024, originToken);
        expect(quote.totalNative).toBe(quote.escrowNative + quote.forwardNative);
      });

      it('cost per blob size is monotonic non-decreasing', () => {
        let prev = 0;
        for (const size of SIZES) {
          const { quote } = quoteFor(size, originToken);
          expect(quote.breakdown.escrowUsd).toBeGreaterThanOrEqual(prev);
          prev = quote.breakdown.escrowUsd;
        }
      });
    });
  }

  it('WAL cost is a small fraction of the round-trip (return leg dominates)', () => {
    // Confirms the buffer-strategy premise: WAL storage is a rounding error vs the
    // SUI return leg, so the quote is dominated by the return fee, not storage.
    const { walCostFrost } = quoteFor(1024 * 1024, 'ETH');
    const walUsd = amountToUsd(walCostFrost, FROST_DECIMALS, PRICES.WAL.usd);
    const returnUsd = amountToUsd(RETURN_LZ_MIST, MIST_DECIMALS, PRICES.SUI.usd);
    expect(walUsd).toBeLessThan(returnUsd * 0.05);
  });
});
