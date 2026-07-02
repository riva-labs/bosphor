import { ethers } from 'ethers';

/**
 * Everything the preflight guard needs from the outside world. Network reads are
 * injected so the decision logic can be unit-tested without a chain.
 */
export interface PreflightDeps {
  getBalanceWei(): Promise<bigint>;
  /** Effective gas price actually paid (baseFee + tip) in wei. See effectiveGasPriceWei. */
  getGasPriceWei(): Promise<bigint>;
  /** Skip the probe when the sender balance is below this many wei. */
  minBalanceWei: bigint;
  /** Skip the probe when gas price is above this many wei. */
  maxGasWei: bigint;
}

export type SkipReason = 'low_balance' | 'high_gas';

/** The subset of ethers' FeeData the gas guard reads. */
export interface FeeLike {
  gasPrice: bigint | null;
  maxFeePerGas: bigint | null;
}

/**
 * The gas price the submit actually pays, in wei.
 *
 * ethers pads maxFeePerGas to `baseFee * 2 + tip` as an inclusion ceiling, so
 * gating the guard on it skips at roughly half the configured threshold (a
 * 25 gwei base fee trips a "50 gwei" guard). gasPrice is eth_gasPrice, the
 * effective cost. Prefer it; fall back to the ceiling only when the node does
 * not return gasPrice (non-EIP-1559 / partial FeeData).
 */
export function effectiveGasPriceWei(fee: FeeLike): bigint {
  return fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
}

export interface PreflightResult {
  ok: boolean;
  reason?: SkipReason;
  /** Balance in ETH for the gauge; NaN if the read failed this tick. */
  balanceEth: number;
  /** Gas price in gwei for the gauge; NaN if the read failed this tick. */
  gasGwei: number;
}

/**
 * Guard run before every probe. Reads wallet balance and current gas price and
 * decides whether it is safe to submit a paid intent this tick.
 *
 * Two failure modes it prevents, both learned from a real drain:
 *  - low_balance: the sender ran out of testnet gas, so every submit reverts
 *    with INSUFFICIENT_FUNDS and the balance can never recover on its own. We
 *    skip (and alert on the balance gauge) instead of spamming failed submits.
 *  - high_gas: a Sepolia base-fee spike (observed at 400+ gwei vs ~2 gwei
 *    normal) makes a single probe cost 100x and drains the buffer in hours.
 *    Skipping the tick protects the funds; the next tick retries once gas
 *    settles.
 *
 * Balance is checked before gas: an empty wallet is the actionable root cause
 * (someone must refill it), whereas high gas resolves on its own.
 *
 * Never throws: a transient RPC read error leaves that value as NaN and does not
 * block the probe, so a flaky node cannot silently halt the canary. The submit
 * itself still has its own error handling.
 */
export async function preflight(deps: PreflightDeps): Promise<PreflightResult> {
  let balanceWei: bigint | null = null;
  let gasWei: bigint | null = null;

  try {
    balanceWei = await deps.getBalanceWei();
  } catch {
    // transient RPC error; leave balance unknown for this tick
  }
  try {
    gasWei = await deps.getGasPriceWei();
  } catch {
    // transient RPC error; leave gas unknown for this tick
  }

  const balanceEth = balanceWei === null ? NaN : Number(ethers.formatEther(balanceWei));
  const gasGwei = gasWei === null ? NaN : Number(gasWei) / 1e9;

  if (balanceWei !== null && balanceWei < deps.minBalanceWei) {
    return { ok: false, reason: 'low_balance', balanceEth, gasGwei };
  }
  if (gasWei !== null && gasWei > deps.maxGasWei) {
    return { ok: false, reason: 'high_gas', balanceEth, gasGwei };
  }
  return { ok: true, balanceEth, gasGwei };
}
