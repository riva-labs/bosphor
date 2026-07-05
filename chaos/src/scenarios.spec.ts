import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChaosDeps } from './deps.ts';
import {
  relayerCrashScenario,
  suiRpcOutageScenario,
  evmRpcOutageScenario,
  lowWalTopUpScenario,
  walrusEpochRolloverScenario,
  gasSpikeCanarySkipScenario,
  deadlineExpiryScenario,
  allScenarios,
} from './scenarios.ts';

const FAST = { fulfillMs: 1000, outageMs: 100, settleMs: 50, pollMs: 10 };

function makeFakeDeps(overrides: Partial<ChaosDeps> = {}): ChaosDeps {
  let clock = 0;
  return {
    log: () => {},
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    submitIntent: async () => ({ intentId: '0xintent' }),
    isFulfilled: async () => true,
    stopRelayer: async () => {},
    startRelayer: async () => {},
    setChainRpc: async () => {},
    getWalBalanceMist: async () => 0n,
    drainWalTo: async () => {},
    forceWalrusEpochRollover: async () => {},
    setGasPriceGwei: async () => {},
    getCanarySkipCount: async () => 0,
    ...overrides,
  };
}

test('relayer-crash: recovers when the intent fulfills after restart', async () => {
  let restarted = false;
  const deps = makeFakeDeps({
    startRelayer: async () => {
      restarted = true;
    },
    isFulfilled: async () => restarted,
  });

  const outcome = await relayerCrashScenario(deps, FAST).run();

  assert.equal(outcome.recovered, true);
  assert.ok(outcome.evidence.some((e) => /fulfilled after restart/.test(e)));
});

test('relayer-crash: fails when the intent never fulfills', async () => {
  const deps = makeFakeDeps({ isFulfilled: async () => false });

  const outcome = await relayerCrashScenario(deps, FAST).run();

  assert.equal(outcome.recovered, false);
  assert.match(outcome.error ?? '', /no fulfillment/);
});

test('sui-rpc-outage: recovers once RPC is restored', async () => {
  let rpcUp = true;
  const deps = makeFakeDeps({
    setChainRpc: async (_chain, up) => {
      rpcUp = up;
    },
    isFulfilled: async () => rpcUp,
  });

  const outcome = await suiRpcOutageScenario(deps, FAST).run();

  assert.equal(outcome.recovered, true);
  assert.ok(outcome.evidence.some((e) => /took sui RPC down/.test(e)));
});

test('evm-rpc-outage: names the evm chain', async () => {
  const outcome = await evmRpcOutageScenario(makeFakeDeps(), FAST).run();
  assert.equal(outcome.recovered, true);
  assert.ok(outcome.evidence.some((e) => /evm RPC/.test(e)));
});

test('low-wal: recovers only when balance is topped up and intent fulfills', async () => {
  let balance = 0n;
  const deps = makeFakeDeps({
    drainWalTo: async (mist) => {
      balance = mist;
    },
    getWalBalanceMist: async () => balance,
    submitIntent: async () => {
      balance = 1_000_000_000n; // top-up happens during fulfillment
      return { intentId: '0xintent' };
    },
  });

  const outcome = await lowWalTopUpScenario(deps, FAST).run();

  assert.equal(outcome.recovered, true);
  assert.ok(outcome.evidence.some((e) => /topped up/.test(e)));
});

test('low-wal: fails when no top-up occurs', async () => {
  const deps = makeFakeDeps({ getWalBalanceMist: async () => 0n });
  const outcome = await lowWalTopUpScenario(deps, FAST).run();
  assert.equal(outcome.recovered, false);
});

test('walrus-epoch-rollover: recovers after cache reset + retry', async () => {
  let rolled = false;
  const deps = makeFakeDeps({
    forceWalrusEpochRollover: async () => {
      rolled = true;
    },
    isFulfilled: async () => rolled,
  });

  const outcome = await walrusEpochRolloverScenario(deps, FAST).run();

  assert.equal(outcome.recovered, true);
});

test('gas-spike: passes when the canary skip counter increases', async () => {
  let gwei = 20;
  const deps = makeFakeDeps({
    setGasPriceGwei: async (g) => {
      gwei = g;
    },
    getCanarySkipCount: async () => (gwei > 50 ? 1 : 0),
  });

  const outcome = await gasSpikeCanarySkipScenario(deps, FAST).run();

  assert.equal(outcome.recovered, true);
  assert.ok(outcome.evidence.some((e) => /canary skips: 0 -> 1/.test(e)));
});

test('deadline-expiry: passes when an expired intent is NOT fulfilled', async () => {
  const deps = makeFakeDeps({ isFulfilled: async () => false });
  const outcome = await deadlineExpiryScenario(deps, FAST).run();
  assert.equal(outcome.recovered, true);
  assert.ok(outcome.evidence.some((e) => /correctly skipped/.test(e)));
});

test('deadline-expiry: fails (flags a bug) when an expired intent executes', async () => {
  const deps = makeFakeDeps({ isFulfilled: async () => true });
  const outcome = await deadlineExpiryScenario(deps, FAST).run();
  assert.equal(outcome.recovered, false);
  assert.match(outcome.error ?? '', /instead of skipped/);
});

test('allScenarios returns the seven scenarios in order', () => {
  const names = allScenarios(makeFakeDeps(), FAST).map((s) => s.name);
  assert.deepEqual(names, [
    'relayer-crash-midflight',
    'sui-rpc-outage',
    'evm-rpc-outage',
    'low-wal-auto-topup',
    'walrus-epoch-rollover',
    'gas-spike-canary-skip',
    'deadline-expiry-skip',
  ]);
});
