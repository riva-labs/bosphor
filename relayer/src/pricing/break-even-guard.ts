import { PriceSet } from './price-oracle.types';
import { OriginToken } from './quote-engine';
import { FROST_DECIMALS, MIST_DECIMALS, NATIVE_DECIMALS, amountToUsd } from './pricing-math';

export interface BreakEvenInputs {
  /** Amount escrowed by the user, in origin native smallest unit. */
  escrowNative: bigint;
  /** Origin chain native token the escrow is denominated in. */
  originToken: OriginToken;
  /** ACTUAL relayer-fronted costs recomputed at execution time (no buffers). */
  walCostFrost: bigint;
  returnLzFeeMist: bigint;
  suiGasMist: bigint;
  /** Minimum profit margin required over cost to proceed (e.g. 0.1 = 10%). */
  minMarginRatio: number;
  /** Live USD prices. */
  prices: PriceSet;
}

export interface BreakEvenDecision {
  /** Proceed with the WAL spend only if true. */
  proceed: boolean;
  /** Escrow value at live prices, USD. */
  escrowUsd: number;
  /** Recomputed actual cost (WAL + Sui gas + return LZ), USD. */
  costUsd: number;
  /** cost * (1 + minMargin): the escrow must cover this to proceed. */
  requiredUsd: number;
  /** escrowUsd - costUsd (the realized margin if we proceed). */
  marginUsd: number;
  /** marginUsd / costUsd, or Infinity when cost is zero. */
  marginRatio: number;
  reason: string;
}

/**
 * The never-lose-money gate. Evaluated on the relayer immediately before any WAL
 * spend: it recomputes the ACTUAL relayer-fronted cost at live prices and only
 * proceeds if the escrow value covers that cost plus a minimum margin. If not, it
 * SKIPS: no WAL is spent, the intent refunds to the user on its deadline, and
 * Bosphor is out nothing. Every completed intent is therefore profitable by
 * construction, and every skipped one is free. Pure and deterministic.
 */
export function evaluateBreakEven(inputs: BreakEvenInputs): BreakEvenDecision {
  const { prices } = inputs;
  const walPrice = requirePrice(prices, 'WAL');
  const suiPrice = requirePrice(prices, 'SUI');
  const originPrice = requirePrice(prices, inputs.originToken);

  if (inputs.escrowNative < 0n) {
    throw new Error('BreakEvenGuard: escrowNative must be non-negative');
  }
  for (const [name, v] of [
    ['walCostFrost', inputs.walCostFrost],
    ['returnLzFeeMist', inputs.returnLzFeeMist],
    ['suiGasMist', inputs.suiGasMist],
  ] as const) {
    if (v < 0n) throw new Error(`BreakEvenGuard: ${name} must be non-negative`);
  }

  const escrowUsd = amountToUsd(
    inputs.escrowNative,
    NATIVE_DECIMALS[inputs.originToken],
    originPrice,
  );
  const walUsd = amountToUsd(inputs.walCostFrost, FROST_DECIMALS, walPrice);
  const returnUsd = amountToUsd(inputs.returnLzFeeMist, MIST_DECIMALS, suiPrice);
  const suiGasUsd = amountToUsd(inputs.suiGasMist, MIST_DECIMALS, suiPrice);
  const costUsd = walUsd + returnUsd + suiGasUsd;

  const requiredUsd = costUsd * (1 + inputs.minMarginRatio);
  const marginUsd = escrowUsd - costUsd;
  const marginRatio = costUsd > 0 ? marginUsd / costUsd : Number.POSITIVE_INFINITY;
  const proceed = escrowUsd >= requiredUsd;

  return {
    proceed,
    escrowUsd,
    costUsd,
    requiredUsd,
    marginUsd,
    marginRatio,
    reason: proceed
      ? `escrow $${escrowUsd.toFixed(4)} >= required $${requiredUsd.toFixed(4)} ` +
        `(cost $${costUsd.toFixed(4)} + ${(inputs.minMarginRatio * 100).toFixed(0)}% margin)`
      : `SKIP: escrow $${escrowUsd.toFixed(4)} < required $${requiredUsd.toFixed(4)} ` +
        `(cost $${costUsd.toFixed(4)} + ${(inputs.minMarginRatio * 100).toFixed(0)}% margin)`,
  };
}

function requirePrice(prices: PriceSet, token: 'WAL' | 'SUI' | 'ETH' | 'SOL'): number {
  const p = prices[token]?.usd;
  if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) {
    throw new Error(`BreakEvenGuard: missing or non-positive ${token} price`);
  }
  return p;
}
