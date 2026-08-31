import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientRpcError, reportProbeFailure, type CaptureLike } from './error-report.ts';

function makeCapture() {
  const calls: Array<{ err: unknown; tags?: Record<string, string> }> = [];
  const capture: CaptureLike = {
    captureException: (err, context) => calls.push({ err, tags: context?.tags }),
  };
  return { capture, calls };
}

test('reports a failed probe with intent id and stage tags', () => {
  const { capture, calls } = makeCapture();

  reportProbeFailure(capture, {
    success: false,
    intentId: '0xabc',
    failedStage: 'return',
    error: 'timeout',
    chain: 'solana',
  });

  assert.equal(calls.length, 1);
  assert.match((calls[0].err as Error).message, /timeout/);
  assert.deepEqual(calls[0].tags, { intentId: '0xabc', stage: 'return', chain: 'solana' });
});

test('does not report a successful probe', () => {
  const { capture, calls } = makeCapture();

  reportProbeFailure(capture, { success: true, intentId: '0xabc' });

  assert.equal(calls.length, 0);
});

test('falls back to unknown stage when none is given', () => {
  const { capture, calls } = makeCapture();

  reportProbeFailure(capture, { success: false, intentId: '0xabc' });

  assert.equal(calls[0].tags?.stage, 'unknown');
});

test('omits the intentId tag when the probe failed before an intent existed', () => {
  const { capture, calls } = makeCapture();

  reportProbeFailure(capture, { success: false, intentId: '', failedStage: 'submit', chain: 'solana' });

  assert.deepEqual(calls[0].tags, { stage: 'submit', chain: 'solana' });
});

test('classifies RPC rate limits and timeouts as transient', () => {
  assert.equal(isTransientRpcError(new Error('429 Too Many Requests: {"code": 429}')), true);
  assert.equal(isTransientRpcError(new Error('request timeout (code=TIMEOUT)')), true);
  assert.equal(isTransientRpcError(new Error('proof mismatch for intent 0xabc')), false);
});
