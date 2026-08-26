import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanaryMetrics } from './metrics.ts';

test('records a successful round-trip with duration and last-success timestamp, per chain', async () => {
  const m = new CanaryMetrics();

  m.recordSuccess('evm', 42, 1700000000);

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_roundtrip_total\{chain="evm",result="success"\} 1/);
  assert.match(out, /bosphor_canary_roundtrip_duration_seconds_count\{chain="evm"\} 1/);
  assert.match(out, /bosphor_canary_last_success_timestamp_seconds\{chain="evm"\} 1700000000/);
});

test('keeps chains separate on the same registry', async () => {
  const m = new CanaryMetrics();

  m.recordSuccess('evm', 10, 1700000000);
  m.recordFailure('solana');

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_roundtrip_total\{chain="evm",result="success"\} 1/);
  assert.match(out, /bosphor_canary_roundtrip_total\{chain="solana",result="failure"\} 1/);
});

test('counts failures separately from successes', async () => {
  const m = new CanaryMetrics();

  m.recordFailure('evm');
  m.recordFailure('evm');

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_roundtrip_total\{chain="evm",result="failure"\} 2/);
});

test('records per-stage durations, per chain', async () => {
  const m = new CanaryMetrics();

  m.observeStage('solana', 'return_delivery', 12.5);

  const out = await m.getMetrics();
  assert.match(
    out,
    /bosphor_canary_stage_duration_seconds_count\{chain="solana",stage="return_delivery"\} 1/,
  );
});

test('publishes EVM wallet balance and gas price gauges', async () => {
  const m = new CanaryMetrics();

  m.setWalletBalanceEth(0.0342);
  m.setGasPrice(432);

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_wallet_balance_eth 0.0342/);
  assert.match(out, /bosphor_canary_gas_price_gwei 432/);
});

test('publishes the Solana wallet balance gauge', async () => {
  const m = new CanaryMetrics();

  m.setWalletBalanceSol(1.5);

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_wallet_balance_sol 1.5/);
});

test('ignores non-finite gauge reads instead of publishing NaN', async () => {
  const m = new CanaryMetrics();

  m.setWalletBalanceEth(NaN);
  m.setWalletBalanceSol(NaN);
  m.setGasPrice(NaN);

  const out = await m.getMetrics();
  assert.doesNotMatch(out, /bosphor_canary_wallet_balance_eth Nan/i);
  assert.doesNotMatch(out, /bosphor_canary_wallet_balance_sol Nan/i);
  assert.doesNotMatch(out, /bosphor_canary_gas_price_gwei Nan/i);
});

test('counts skipped probes by chain and reason', async () => {
  const m = new CanaryMetrics();

  m.recordSkip('evm', 'low_balance');
  m.recordSkip('evm', 'high_gas');
  m.recordSkip('solana', 'low_balance');

  const out = await m.getMetrics();
  assert.match(out, /bosphor_canary_skipped_total\{chain="evm",reason="low_balance"\} 1/);
  assert.match(out, /bosphor_canary_skipped_total\{chain="evm",reason="high_gas"\} 1/);
  assert.match(out, /bosphor_canary_skipped_total\{chain="solana",reason="low_balance"\} 1/);
});
