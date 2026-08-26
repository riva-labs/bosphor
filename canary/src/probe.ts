import type { CanaryChain } from './metrics.ts';
import type { SkipReason } from './preflight.ts';

/**
 * A synthetic round-trip against one origin chain, split into the two legs the
 * canary times independently: `submit` (encode -> submit -> upload, the forward
 * path) and `awaitProof` (the return proof landing back on the origin). Each
 * chain implements this over its SDK client so `runProbe` stays chain-agnostic.
 */
export interface ChainProbe {
  readonly chain: CanaryChain;
  /** Human label for logs, e.g. `0xabc… -> Sui(40378)`. */
  readonly label: string;
  /** Read balance (and gas, on EVM) and decide whether to submit this tick. */
  preflight(): Promise<PreflightOutcome>;
  /**
   * Encode + submit + upload one synthetic intent, returning its id. Runs the
   * real SDK `store` forward legs so the probe exercises the integrator path.
   * Throws on any forward-leg failure.
   */
  submit(): Promise<{ intentId: string }>;
  /** Poll until the return proof lands on the origin chain; throws on timeout. */
  awaitProof(intentId: string, maxWaitMs: number): Promise<void>;
}

/** What a probe's preflight reports up to the runner: safe-to-submit + gauges. */
export interface PreflightOutcome {
  ok: boolean;
  reason?: SkipReason;
  /** Sender balance in the chain's native token (ETH or SOL); NaN on a failed read. */
  balanceNative: number;
  /** Current gas price in gwei (EVM only); omitted on chains without a gas market. */
  gasGwei?: number;
}

export interface ProbeResult {
  chain: CanaryChain;
  success: boolean;
  intentId: string;
  roundtripSeconds?: number;
  submitSeconds?: number;
  returnSeconds?: number;
  failedStage?: 'submit' | 'return';
  error?: string;
}

export interface RunProbeDeps {
  maxWaitMs: number;
  /** Injectable clock so the runner's timing can be unit-tested without real waits. */
  now?: () => number;
}

/**
 * Run one synthetic round-trip and time both legs. Never throws: a forward-leg
 * error is reported as a `submit` failure, a missing return proof as a `return`
 * timeout, so a single degraded probe cannot crash the canary loop.
 */
export async function runProbe(probe: ChainProbe, deps: RunProbeDeps): Promise<ProbeResult> {
  const now = deps.now ?? (() => Date.now());
  const t0 = now();
  let intentId = '';
  let submitSeconds = 0;

  try {
    const submitted = await probe.submit();
    intentId = submitted.intentId;
    submitSeconds = (now() - t0) / 1000;
  } catch (err) {
    return {
      chain: probe.chain,
      success: false,
      intentId,
      failedStage: 'submit',
      error: String(err),
    };
  }

  const returnStart = now();
  try {
    await probe.awaitProof(intentId, deps.maxWaitMs);
  } catch (err) {
    return {
      chain: probe.chain,
      success: false,
      intentId,
      failedStage: 'return',
      error: String(err),
      submitSeconds,
    };
  }

  return {
    chain: probe.chain,
    success: true,
    intentId,
    roundtripSeconds: (now() - t0) / 1000,
    submitSeconds,
    returnSeconds: (now() - returnStart) / 1000,
  };
}
