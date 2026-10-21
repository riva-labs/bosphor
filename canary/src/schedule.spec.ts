import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeIntervalMs } from './schedule.ts';

const MIN = 60 * 1000;

test('every chain runs on the shared CANARY_INTERVAL_MS when no per-chain interval is set', () => {
  const env = { CANARY_INTERVAL_MS: String(10 * MIN) };
  assert.equal(probeIntervalMs('evm', env), 10 * MIN);
  assert.equal(probeIntervalMs('solana', env), 10 * MIN);
});

test('CANARY_SOLANA_INTERVAL_MS slows only the Solana probe, EVM keeps the shared interval', () => {
  const env = { CANARY_INTERVAL_MS: String(10 * MIN), CANARY_SOLANA_INTERVAL_MS: String(30 * MIN) };
  assert.equal(probeIntervalMs('solana', env), 30 * MIN);
  assert.equal(probeIntervalMs('evm', env), 10 * MIN);
});
