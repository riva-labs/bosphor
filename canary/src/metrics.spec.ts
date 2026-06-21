import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanaryMetrics } from './metrics.ts';

test('records a successful round-trip with duration and last-success timestamp', async () => {
  const m = new CanaryMetrics();

  m.recordSuccess(42, 1700000000);

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_roundtrip_total\{result="success"\} 1/);
  assert.match(out, /bosphor_canary_roundtrip_duration_seconds_count 1/);
  assert.match(out, /bosphor_canary_last_success_timestamp_seconds 1700000000/);
});

test('counts failures separately from successes', async () => {
  const m = new CanaryMetrics();

  m.recordFailure();
  m.recordFailure();

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_roundtrip_total\{result="failure"\} 2/);
});

test('records per-stage durations', async () => {
  const m = new CanaryMetrics();

  m.observeStage('return_delivery', 12.5);

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_stage_duration_seconds_count\{stage="return_delivery"\} 1/);
});
