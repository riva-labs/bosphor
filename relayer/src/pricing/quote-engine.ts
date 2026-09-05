import { PriceSet, PriceToken } from './price-oracle.types';

/** Native token of the origin chain the user pays on. */
export type OriginToken = 'ETH' | 'SOL';

// Smallest-unit decimals per token.
const FROST_DECIMALS = 9; // WAL
const MIST_DECIMALS = 9; // SUI
const NATIVE_DECIMALS: Record<OriginToken, number> = { ETH: 18, SOL: 9 };

export interface QuoteBuffers {
  /** Buffer on the volatile SUI return leg (heaviest). */
  returnLeg: number;
  /** Buffer on Sui gas. */
  suiGas: number;
  /** Buffer on WAL storage (small; WAL is a rounding error in USD). */
  wal: number;
  /** Extra buffer on the SUI->origin-native cross-rate conversion. */
  crossRate: number;
}

export interface QuoteConfig {
  buffers: QuoteBuffers;
  /** Service margin applied on top of the buffered cost. */
  serviceMarginRatio: number;
  /** Minimum escrow charge in USD (covers fixed overhead / tiny files). */
  minChargeUsd: number;
}

export interface QuoteCostInputs {
  /** Which native token the user pays in. */
  originToken: OriginToken;
  /** WAL storage cost in FROST (from WalCostCalculator). */
  walCostFrost: bigint;
  /** Sui->EVM return LZ fee in SUI MIST (relayer-fronted). */
  returnLzFeeMist: bigint;
  /** Sui gas for execute_store + proof in SUI MIST (relayer-fronted). */
  suiGasMist: bigint;
  /** Forward LZ nativeFee in origin smallest unit (user pays directly). */
  forwardLzFeeNative: bigint;
  /** Origin tx gas in origin smallest unit (user pays directly). */
  originGasNative: bigint;
}

export interface QuoteBreakdown {
  walCostUsd: number;
  returnLzUsd: number;
  suiGasUsd: number;
  forwardLzUsd: number;
  originGasUsd: number;
  /** Buffered relayer-fronted bucket after the min-charge floor, before margin. */
  bufferedEscrowUsd: number;
  serviceMarginUsd: number;
  /** Escrowed amount in USD (buffered + margin). */
  escrowUsd: number;
  /** User-direct amount in USD (forward LZ + origin gas). */
  forwardUsd: number;
  totalUsd: number;
  floorApplied: boolean;
}

export interface Quote {
  originToken: OriginToken;
  /** Relayer-fronted bucket, escrowed at submit (origin smallest unit). */
  escrowNative: bigint;
  /** User-direct bucket (forward LZ + origin gas), origin smallest unit. */
  forwardNative: bigint;
  /** escrowNative + forwardNative = msg.value at submit. */
  totalNative: bigint;
  breakdown: QuoteBreakdown;
  prices: PriceSet;
}

/**
 * Pure full-stack quote engine. Given the raw cost components (from
 * WalCostCalculator + on-chain quotes) and live USD prices (from PriceOracle),
 * it produces a single origin-native amount plus a structured breakdown.
 *
 * The escrowed bucket is the relayer-fronted cost (WAL + Sui gas + return LZ)
 * converted to origin-native at live prices, with buffers weighted to the
 * volatile SUI return leg and the ETH/SUI cross-rate, a service margin, and a
 * minimum-charge floor. The forward LZ fee and origin gas are user-direct
 * (spent by _lzSend / the tx itself, refunded by LZ on overpay) and carry no
 * buffer since they are not the intermediary's FX risk. Quoting is off chain;
 * contracts hold no oracle. It never fabricates: bad input throws.
 */
export class QuoteEngine {
  constructor(private readonly config: QuoteConfig) {}

  quote(inputs: QuoteCostInputs, prices: PriceSet): Quote {
    this.assertNonNegative('walCostFrost', inputs.walCostFrost);
    this.assertNonNegative('returnLzFeeMist', inputs.returnLzFeeMist);
    this.assertNonNegative('suiGasMist', inputs.suiGasMist);
    this.assertNonNegative('forwardLzFeeNative', inputs.forwardLzFeeNative);
    this.assertNonNegative('originGasNative', inputs.originGasNative);

    const originPrice = this.priceOf(prices, inputs.originToken);
    const walPrice = this.priceOf(prices, 'WAL');
    const suiPrice = this.priceOf(prices, 'SUI');

    // Raw USD per component.
    const walCostUsd = frostToUnits(inputs.walCostFrost, FROST_DECIMALS) * walPrice;
    const returnLzUsd = frostToUnits(inputs.returnLzFeeMist, MIST_DECIMALS) * suiPrice;
    const suiGasUsd = frostToUnits(inputs.suiGasMist, MIST_DECIMALS) * suiPrice;
    const originDecimals = NATIVE_DECIMALS[inputs.originToken];
    const forwardLzUsd = frostToUnits(inputs.forwardLzFeeNative, originDecimals) * originPrice;
    const originGasUsd = frostToUnits(inputs.originGasNative, originDecimals) * originPrice;

    const { buffers, serviceMarginRatio, minChargeUsd } = this.config;
    // Buffer the relayer-fronted bucket: WAL barely, SUI return leg + gas heavily,
    // with an extra cross-rate buffer on the SUI->native conversion.
    const walBuffered = walCostUsd * (1 + buffers.wal);
    const returnBuffered = returnLzUsd * (1 + buffers.returnLeg) * (1 + buffers.crossRate);
    const suiGasBuffered = suiGasUsd * (1 + buffers.suiGas) * (1 + buffers.crossRate);
    const bufferedRaw = walBuffered + returnBuffered + suiGasBuffered;

    const floorApplied = bufferedRaw < minChargeUsd;
    const bufferedEscrowUsd = Math.max(bufferedRaw, minChargeUsd);
    const serviceMarginUsd = bufferedEscrowUsd * serviceMarginRatio;
    const escrowUsd = bufferedEscrowUsd + serviceMarginUsd;

    const forwardUsd = forwardLzUsd + originGasUsd;
    const totalUsd = escrowUsd + forwardUsd;

    const escrowNative = usdToNative(escrowUsd, originPrice, originDecimals);
    const forwardNative = inputs.forwardLzFeeNative + inputs.originGasNative;

    return {
      originToken: inputs.originToken,
      escrowNative,
      forwardNative,
      totalNative: escrowNative + forwardNative,
      breakdown: {
        walCostUsd,
        returnLzUsd,
        suiGasUsd,
        forwardLzUsd,
        originGasUsd,
        bufferedEscrowUsd,
        serviceMarginUsd,
        escrowUsd,
        forwardUsd,
        totalUsd,
        floorApplied,
      },
      prices,
    };
  }

  private assertNonNegative(name: string, v: bigint): void {
    if (typeof v !== 'bigint' || v < 0n) {
      throw new Error(`QuoteEngine: ${name} must be a non-negative fee, got ${v}`);
    }
  }

  private priceOf(prices: PriceSet, token: PriceToken): number {
    const p = prices[token]?.usd;
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) {
      throw new Error(`QuoteEngine: missing or non-positive ${token} price`);
    }
    return p;
  }
}

/** Convert a smallest-unit bigint to whole token units (Number, quote-grade). */
function frostToUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/**
 * Convert a USD amount to the origin native smallest unit, rounding UP so the
 * escrow never under-covers (over-charge is acceptable per the never-lose-money
 * directive). Fixed-point via 1e9 sub-units keeps precision without float dust.
 */
function usdToNative(usd: number, priceUsd: number, decimals: number): bigint {
  const wholeUnits = usd / priceUsd;
  const SUBUNIT = 9;
  const sub = BigInt(Math.ceil(wholeUnits * 10 ** SUBUNIT));
  const scale = 10n ** BigInt(decimals - SUBUNIT);
  return decimals >= SUBUNIT ? sub * scale : sub / 10n ** BigInt(SUBUNIT - decimals);
}
