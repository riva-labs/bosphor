import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runProbe, type ChainProbe } from './probe.ts';

function fakeProbe(overrides: Partial<ChainProbe> = {}): ChainProbe {
  return {
    chain: 'evm',
    label: 'test-probe',
    preflight: async () => ({ ok: true, balanceNative: 1 }),
    submit: async () => ({ intentId: '0x' + 'ab'.repeat(32) }),
    awaitProof: async () => {},
    ...overrides,
  };
}

// A monotonic clock so the runner records positive, well-ordered leg timings
// without real waits.
function clock(startMs = 1_000_000, stepMs = 100): () => number {
  let t = startMs;
  return () => (t += stepMs);
}

test('reports success once the return proof lands', async () => {
  const res = await runProbe(fakeProbe(), { maxWaitMs: 1000, now: clock() });
  assert.equal(res.success, true);
  assert.equal(res.chain, 'evm');
  assert.match(res.intentId, /^0x[0-9a-f]{64}$/);
  assert.ok(res.roundtripSeconds !== undefined && res.roundtripSeconds > 0);
  assert.ok(res.submitSeconds !== undefined && res.submitSeconds > 0);
  assert.ok(res.returnSeconds !== undefined && res.returnSeconds > 0);
});

test('reports a submit-stage failure when the forward leg throws', async () => {
  const res = await runProbe(
    fakeProbe({
      submit: async () => {
        throw new Error('insufficient funds');
      },
    }),
    { maxWaitMs: 1000, now: clock() },
  );
  assert.equal(res.success, false);
  assert.equal(res.failedStage, 'submit');
  assert.match(res.error ?? '', /insufficient funds/);
});

test('reports a return-stage failure when the proof never lands', async () => {
  const res = await runProbe(
    fakeProbe({
      chain: 'solana',
      awaitProof: async () => {
        throw new Error('timeout');
      },
    }),
    { maxWaitMs: 1000, now: clock() },
  );
  assert.equal(res.success, false);
  assert.equal(res.chain, 'solana');
  assert.equal(res.failedStage, 'return');
  assert.ok(res.submitSeconds !== undefined && res.submitSeconds > 0);
});
