import { ethers } from 'ethers';

/**
 * A nonce conflict is a mempool-level collision, not a transient RPC blip: the
 * pending nonce we built the tx with is already claimed (a competing tx from the
 * same wallet holds it, REPLACEMENT_UNDERPRICED) or has already been mined
 * (NONCE_EXPIRED / "nonce too low"). Both are recoverable, but only by
 * rebuilding the tx with a freshly fetched pending nonce and bumped fees, never
 * by resending the same signed bytes. See riva-labs/bosphor#364.
 */
const NONCE_CONFLICT_ETHERS_CODES = new Set(['REPLACEMENT_UNDERPRICED', 'NONCE_EXPIRED']);

const NONCE_CONFLICT_MESSAGE_RE =
  /replacement transaction underpriced|nonce expired|nonce too low|already known|known transaction/i;

/** True when an EVM send failed because its nonce collided in the mempool. */
export function isNonceConflictError(err: unknown, depth = 0): boolean {
  if (depth > 5 || !err || typeof err !== 'object') return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && NONCE_CONFLICT_ETHERS_CODES.has(code)) return true;

  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && NONCE_CONFLICT_MESSAGE_RE.test(message)) return true;

  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isNonceConflictError(cause, depth + 1);

  return false;
}

/** Minimum bump ratio a replacement tx needs over the tx it replaces. Ethereum
 * clients require >= 10%; we use 12% so an off-by-rounding bump is never rejected. */
export const FEE_BUMP_NUMERATOR = 112n;
export const FEE_BUMP_DENOMINATOR = 100n;

/** Ceiling on how far fees may be bumped across rebuilds, so a run of conflicts
 * can never escalate the gas price without bound. */
export const MAX_FEE_BUMPS = 3;

/** Bump a fee value by {@link FEE_BUMP_NUMERATOR}/{@link FEE_BUMP_DENOMINATOR}
 * (12%), rounding up so the result always clears the client's replacement floor. */
export function bumpFee(fee: bigint): bigint {
  return (fee * FEE_BUMP_NUMERATOR + (FEE_BUMP_DENOMINATOR - 1n)) / FEE_BUMP_DENOMINATOR;
}

/** The EIP-1559 fee pair used to build a confirm tx, bumpable across rebuilds. */
export interface FeeOverrides {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Bump both legs of an EIP-1559 fee pair by the replacement floor. */
export function bumpFeeOverrides(fees: FeeOverrides): FeeOverrides {
  return {
    maxFeePerGas: bumpFee(fees.maxFeePerGas),
    maxPriorityFeePerGas: bumpFee(fees.maxPriorityFeePerGas),
  };
}

/**
 * Seed the EIP-1559 fee pair for the first confirm attempt from the network's
 * current suggestion. Falls back to a modest floor when the provider returns no
 * fee data (some testnet RPCs omit it), so we never send a zero-fee tx.
 */
export async function initialFeeOverrides(provider: ethers.Provider): Promise<FeeOverrides> {
  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits('1.5', 'gwei');
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits('1.5', 'gwei');
  return { maxFeePerGas, maxPriorityFeePerGas };
}
