/**
 * Operator funding faults: the relayer's own Sui wallet cannot pay for a store
 * (no SUI for gas, no WAL for the Walrus storage payment). These are never the
 * intent's fault, so the store queue must not count them as attempts or
 * dead-letter the row (which would drop the user's bytes). The row waits,
 * backed off, until the operator funds the wallet.
 */
export type FundingFault = 'insufficient_gas' | 'insufficient_wal';

// WAL short: coinWithBalance (used by the Walrus SDK for the storage payment)
// throws "Insufficient balance of <pkg>::wal::WAL for owner ...".
const WAL_PATTERNS: RegExp[] = [
  /insufficient balance of \S*::wal::WAL\b/i,
  /insufficient WAL\b/i,
  /not enough WAL\b/i,
];

// SUI short for gas: server-side gas selection ("Unable to perform gas
// selection due to insufficient SUI balance ..."), the SDK finding no gas coin,
// a gas coin below the budget, or a SUI coinWithBalance shortfall.
const GAS_PATTERNS: RegExp[] = [
  /unable to perform gas selection/i,
  /insufficient SUI balance/i,
  /no valid gas coins/i,
  /\bInsufficientGas\b/,
  /\bGasBalanceTooLow\b/,
  /balance of gas object \S+ is lower than/i,
  /insufficient balance of 0x0*2::sui::SUI\b/i,
];

/**
 * Classify a store error as an operator funding fault, or null for anything
 * else (which keeps the normal bounded retry and dead-letter behaviour).
 * Pure: string matching only, so it is safe on any thrown value.
 */
export function classifyFundingFault(err: unknown): FundingFault | null {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? '');
  if (WAL_PATTERNS.some((re) => re.test(msg))) return 'insufficient_wal';
  if (GAS_PATTERNS.some((re) => re.test(msg))) return 'insufficient_gas';
  return null;
}
