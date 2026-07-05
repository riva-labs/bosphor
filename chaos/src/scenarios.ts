import type { ChaosDeps } from './deps.ts';
import { waitFor } from './deps.ts';
import type { Scenario, ScenarioOutcome } from './types.ts';

/**
 * Tunable timeouts. Defaults suit a live testnet round-trip (~4 min); tests
 * shrink them. A round-trip normally completes well under `fulfillMs`.
 */
export interface ScenarioTimings {
  fulfillMs: number;
  outageMs: number;
  settleMs: number;
  pollMs: number;
}

const DEFAULT_TIMINGS: ScenarioTimings = {
  fulfillMs: 8 * 60 * 1000,
  outageMs: 30 * 1000,
  settleMs: 10 * 1000,
  pollMs: 15 * 1000,
};

function fulfilled(deps: ChaosDeps, intentId: string, t: ScenarioTimings): Promise<boolean> {
  return waitFor(() => deps.isFulfilled(intentId), {
    timeoutMs: t.fulfillMs,
    pollMs: t.pollMs,
    now: deps.now,
    sleep: deps.sleep,
  });
}

/** (1) The relayer is killed mid-flight and must resume and fulfill on restart. */
export function relayerCrashScenario(deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario {
  return {
    name: 'relayer-crash-midflight',
    description: 'Relayer killed mid-flight resumes and fulfills the in-flight intent',
    async run(): Promise<ScenarioOutcome> {
      const evidence: string[] = [];
      const { intentId } = await deps.submitIntent();
      evidence.push(`submitted intent ${intentId}`);
      await deps.sleep(timings.settleMs);
      await deps.stopRelayer();
      evidence.push('killed relayer mid-flight');
      await deps.sleep(timings.settleMs);
      await deps.startRelayer();
      evidence.push('restarted relayer');
      const ok = await fulfilled(deps, intentId, timings);
      evidence.push(ok ? 'intent fulfilled after restart' : 'intent not fulfilled after restart');
      return { recovered: ok, evidence, error: ok ? undefined : 'no fulfillment after restart' };
    },
  };
}

/** (2)/(3) A chain RPC goes down and recovery is expected once it returns. */
function rpcOutageScenario(deps: ChaosDeps, chain: 'sui' | 'evm', timings: ScenarioTimings): Scenario {
  return {
    name: `${chain}-rpc-outage`,
    description: `${chain.toUpperCase()} RPC outage: relayer recovers and fulfills once RPC returns`,
    async run(): Promise<ScenarioOutcome> {
      const evidence: string[] = [];
      await deps.setChainRpc(chain, false);
      evidence.push(`took ${chain} RPC down`);
      const { intentId } = await deps.submitIntent();
      evidence.push(`submitted intent ${intentId} during outage`);
      await deps.sleep(timings.outageMs);
      await deps.setChainRpc(chain, true);
      evidence.push(`restored ${chain} RPC`);
      const ok = await fulfilled(deps, intentId, timings);
      evidence.push(ok ? 'intent fulfilled after RPC restore' : 'intent not fulfilled after RPC restore');
      return {
        recovered: ok,
        evidence,
        error: ok ? undefined : `no fulfillment after ${chain} RPC restore`,
      };
    },
  };
}

export const suiRpcOutageScenario = (deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario =>
  rpcOutageScenario(deps, 'sui', timings);
export const evmRpcOutageScenario = (deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario =>
  rpcOutageScenario(deps, 'evm', timings);

/** (4) WAL drained below the floor must trigger an auto top-up and still fulfill. */
export function lowWalTopUpScenario(deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario {
  return {
    name: 'low-wal-auto-topup',
    description: 'WAL below the floor triggers an auto top-up and the intent still fulfills',
    async run(): Promise<ScenarioOutcome> {
      const evidence: string[] = [];
      await deps.drainWalTo(0n);
      const before = await deps.getWalBalanceMist();
      evidence.push(`drained WAL to ${before} MIST`);
      const { intentId } = await deps.submitIntent();
      evidence.push(`submitted intent ${intentId}`);
      const ok = await fulfilled(deps, intentId, timings);
      const after = await deps.getWalBalanceMist();
      const toppedUp = after > before;
      evidence.push(`WAL after run: ${after} MIST (${toppedUp ? 'topped up' : 'not topped up'})`);
      const recovered = ok && toppedUp;
      return {
        recovered,
        evidence,
        error: recovered ? undefined : 'no auto top-up and fulfillment observed',
      };
    },
  };
}

/** (5) A Walrus epoch rollover invalidates the SDK cache; upload must reset + retry. */
export function walrusEpochRolloverScenario(deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario {
  return {
    name: 'walrus-epoch-rollover',
    description: 'Walrus epoch rollover triggers SDK cache reset + retry (regression guard)',
    async run(): Promise<ScenarioOutcome> {
      const evidence: string[] = [];
      await deps.forceWalrusEpochRollover();
      evidence.push('forced Walrus epoch rollover (stale SDK cache)');
      const { intentId } = await deps.submitIntent();
      evidence.push(`submitted intent ${intentId}`);
      const ok = await fulfilled(deps, intentId, timings);
      evidence.push(ok ? 'intent fulfilled after cache reset + retry' : 'intent stuck after rollover');
      return {
        recovered: ok,
        evidence,
        error: ok ? undefined : 'upload did not recover after epoch rollover',
      };
    },
  };
}

/** (6) A gas spike must trip the canary preflight skip guard (no paid tx burned). */
export function gasSpikeCanarySkipScenario(deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario {
  return {
    name: 'gas-spike-canary-skip',
    description: 'A gas price spike trips the canary preflight guard, skipping the paid probe',
    async run(): Promise<ScenarioOutcome> {
      const evidence: string[] = [];
      const before = await deps.getCanarySkipCount();
      await deps.setGasPriceGwei(500);
      evidence.push('spiked gas to 500 gwei');
      await deps.sleep(timings.settleMs);
      const after = await deps.getCanarySkipCount();
      await deps.setGasPriceGwei(20);
      evidence.push('restored gas to 20 gwei');
      const skipped = after > before;
      evidence.push(`canary skips: ${before} -> ${after}`);
      return {
        recovered: skipped,
        evidence,
        error: skipped ? undefined : 'canary did not skip under a gas spike',
      };
    },
  };
}

/** (7) An intent past its deadline must be skipped, never mis-executed. */
export function deadlineExpiryScenario(deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario {
  return {
    name: 'deadline-expiry-skip',
    description: 'An intent past its deadline is skipped, not mis-executed',
    async run(): Promise<ScenarioOutcome> {
      const evidence: string[] = [];
      const { intentId } = await deps.submitIntent({ deadlineSecondsFromNow: -1 });
      evidence.push(`submitted intent ${intentId} with an already-expired deadline`);
      await deps.sleep(timings.outageMs);
      const wasFulfilled = await deps.isFulfilled(intentId);
      evidence.push(wasFulfilled ? 'expired intent was executed (BUG)' : 'expired intent correctly skipped');
      return {
        recovered: !wasFulfilled,
        evidence,
        error: wasFulfilled ? 'expired intent was executed instead of skipped' : undefined,
      };
    },
  };
}

/** All scenarios in run order, bound to the given deps. */
export function allScenarios(deps: ChaosDeps, timings = DEFAULT_TIMINGS): Scenario[] {
  return [
    relayerCrashScenario(deps, timings),
    suiRpcOutageScenario(deps, timings),
    evmRpcOutageScenario(deps, timings),
    lowWalTopUpScenario(deps, timings),
    walrusEpochRolloverScenario(deps, timings),
    gasSpikeCanarySkipScenario(deps, timings),
    deadlineExpiryScenario(deps, timings),
  ];
}
