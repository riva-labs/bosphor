import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCanarySkipCount, parseCounter } from './metrics-parse.ts';

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

test('parseCounter reads a bare relayer counter and ignores prefix collisions', () => {
  const text = [
    'bosphor_relayer_wal_spend_skipped_total 4',
    'bosphor_relayer_wal_spend_skipped_total_extra 99',
    'bosphor_relayer_intent_negative_margin_total 0',
  ].join('\n');
  assert.equal(parseCounter(text, 'bosphor_relayer_wal_spend_skipped_total'), 4);
  assert.equal(parseCounter(text, 'bosphor_relayer_intent_negative_margin_total'), 0);
  assert.equal(parseCounter(text, 'bosphor_relayer_missing_total'), 0);
});
