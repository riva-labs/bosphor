/**
 * Shared smallest-unit <-> USD conversion helpers used by the quote engine and
 * the break-even guard. Quote-grade precision (Number for USD, fixed-point for
 * the native conversion) is sufficient; the guard always rounds the required
 * cost UP and the quote rounds the charge UP, so rounding never favours a loss.
 */

/** Smallest-unit decimals per token relevant to the payment stack. */
export const FROST_DECIMALS = 9; // WAL
export const MIST_DECIMALS = 9; // SUI
export const NATIVE_DECIMALS: Record<'ETH' | 'SOL', number> = { ETH: 18, SOL: 9 };

/** Convert a smallest-unit bigint to whole token units. */
export function toUnits(amount: bigint, decimals: number): number {
  return Number(amount) / 10 ** decimals;
}

/** USD value of a smallest-unit amount at a given USD price. */
export function amountToUsd(amount: bigint, decimals: number, priceUsd: number): number {
  return toUnits(amount, decimals) * priceUsd;
}

/**
 * Convert a USD amount to the given token's smallest unit, rounding UP so the
 * result never under-covers. Fixed-point via 1e9 sub-units avoids float dust on
 * 18-decimal tokens.
 */
export function usdToNative(usd: number, priceUsd: number, decimals: number): bigint {
  const wholeUnits = usd / priceUsd;
  const SUBUNIT = 9;
  const sub = BigInt(Math.ceil(wholeUnits * 10 ** SUBUNIT));
  return decimals >= SUBUNIT
    ? sub * 10n ** BigInt(decimals - SUBUNIT)
    : sub / 10n ** BigInt(SUBUNIT - decimals);
}
