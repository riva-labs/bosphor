import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe, computeIntentId, type ProbeDeps } from './probe.ts';

function baseDeps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  let clock = 1_000_000;
  return {
    sender: '0x' + '11'.repeat(20),
    dstEid: 40378,
    options: '0x00',
    deadlineSecondsFromNow: 3600,
    pollIntervalMs: 10,
    maxWaitMs: 1000,
    buildPayload: () => new Uint8Array([1, 2, 3]),
    getNonce: async () => 0n,
    quoteFee: async () => 0n,
    submitIntent: async () => {},
    isExecuted: async () => true,
    now: () => (clock += 100),
    sleep: async () => {},
    ...overrides,
  };
}

test('computeIntentId is deterministic and well-formed', () => {
  const sender = '0x' + '11'.repeat(20);
  const a = computeIntentId(sender, 40378, new Uint8Array([1]), 0n, 100);
  const b = computeIntentId(sender, 40378, new Uint8Array([1]), 0n, 100);
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
});

test('reports success once the intent is executed on EVM', async () => {
  const res = await runProbe(baseDeps({ isExecuted: async () => true }));
  assert.equal(res.success, true);
  assert.match(res.intentId, /^0x[0-9a-f]{64}$/);
  assert.ok(res.roundtripSeconds !== undefined && res.roundtripSeconds > 0);
});

test('reports submit-stage failure when submitIntent throws', async () => {
  const res = await runProbe(
    baseDeps({
      submitIntent: async () => {
        throw new Error('insufficient funds');
      },
    }),
  );
  assert.equal(res.success, false);
  assert.equal(res.failedStage, 'submit');
  assert.match(res.error ?? '', /insufficient funds/);
});

test('reports a return-stage timeout when never executed', async () => {
  const res = await runProbe(baseDeps({ isExecuted: async () => false }));
  assert.equal(res.success, false);
  assert.equal(res.failedStage, 'return');
});
