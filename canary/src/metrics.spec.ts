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

test('publishes wallet balance and gas price gauges', async () => {
  const m = new CanaryMetrics();

  m.setWalletBalance(0.0342);
  m.setGasPrice(432);

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_wallet_balance_eth 0.0342/);
  assert.match(out, /bosphor_canary_gas_price_gwei 432/);
});

test('ignores non-finite gauge reads instead of publishing NaN', async () => {
  const m = new CanaryMetrics();

  m.setWalletBalance(NaN);
  m.setGasPrice(NaN);

  const out = await m.getMetrics();
  assert.doesNotMatch(out, /bosphor_canary_wallet_balance_eth Nan/i);
  assert.doesNotMatch(out, /bosphor_canary_gas_price_gwei Nan/i);
});

test('counts skipped probes by reason', async () => {
  const m = new CanaryMetrics();

  m.recordSkip('low_balance');
  m.recordSkip('high_gas');
  m.recordSkip('high_gas');

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_skipped_total\{reason="low_balance"\} 1/);
  assert.match(out, /bosphor_canary_skipped_total\{reason="high_gas"\} 2/);
});
