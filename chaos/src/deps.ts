/**
 * The capabilities a chaos scenario needs to act on the running Bosphor system.
 * Fault-injection and observation are injected so each scenario's recovery
 * logic can be unit-tested with fakes, while `main.ts` binds a real
 * implementation that drives the actual testnet deployment.
 */
export interface ChaosDeps {
  log(msg: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;

  /** Submit a synthetic intent; returns its id. deadlineSecondsFromNow overrides the default. */
  submitIntent(opts?: { deadlineSecondsFromNow?: number }): Promise<{ intentId: string }>;
  /** Whether an intent has been executed (confirmed) on EVM. */
  isFulfilled(intentId: string): Promise<boolean>;

  /** Stop the relayer process. */
  stopRelayer(): Promise<void>;
  /** Start the relayer process. */
  startRelayer(): Promise<void>;

  /** Take a chain's RPC endpoint down / bring it back up (as seen by the relayer). */
  setChainRpc(chain: 'sui' | 'evm', up: boolean): Promise<void>;

  /** Read the relayer's WAL balance in MIST. */
  getWalBalanceMist(): Promise<bigint>;
  /** Drain the relayer's WAL balance below a threshold to force a top-up. */
  drainWalTo(mist: bigint): Promise<void>;

  /** Force the Walrus SDK to observe an epoch rollover (stale cache) on next upload. */
  forceWalrusEpochRollover(): Promise<void>;

  /** Set the observed EVM gas price in gwei (to trip or clear the canary skip guard). */
  setGasPriceGwei(gwei: number): Promise<void>;
  /** Number of canary probes skipped by the preflight guard so far. */
  getCanarySkipCount(): Promise<number>;
}

/**
 * Poll `check` until it returns true or `timeoutMs` elapses. Returns whether it
 * became true in time. Shared by scenarios asserting recovery.
 */
export async function waitFor(
  check: () => Promise<boolean>,
  opts: { timeoutMs: number; pollMs: number; now: () => number; sleep: (ms: number) => Promise<void> },
): Promise<boolean> {
  const start = opts.now();
  while (opts.now() - start < opts.timeoutMs) {
    if (await check()) return true;
    await opts.sleep(opts.pollMs);
  }
  return await check();
}
