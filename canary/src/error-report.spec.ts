import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportProbeFailure, type CaptureLike } from './error-report.ts';

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
  });

  assert.equal(calls.length, 1);
  assert.match((calls[0].err as Error).message, /timeout/);
  assert.deepEqual(calls[0].tags, { intentId: '0xabc', stage: 'return' });
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
