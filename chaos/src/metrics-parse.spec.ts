import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCanarySkipCount } from './metrics-parse.ts';

test('sums all reason series of the canary skip counter', () => {
  const text = [
    '# HELP bosphor_canary_skipped_total Probes skipped',
    '# TYPE bosphor_canary_skipped_total counter',
    'bosphor_canary_skipped_total{reason="gas_spike"} 3',
    'bosphor_canary_skipped_total{reason="low_balance"} 2',
    'bosphor_canary_gas_price_gwei 21',
  ].join('\n');

  assert.equal(parseCanarySkipCount(text), 5);
});

test('returns 0 when the counter is absent', () => {
  assert.equal(parseCanarySkipCount('bosphor_canary_gas_price_gwei 21'), 0);
});
