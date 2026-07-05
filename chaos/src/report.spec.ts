import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from './report.ts';
import type { RecoveryReport } from './types.ts';

const report: RecoveryReport = {
  total: 2,
  passed: 1,
  failed: 1,
  results: [
    {
      name: 'relayer-crash-midflight',
      description: 'Relayer crashes mid-flight and resumes',
      status: 'pass',
      recovered: true,
      evidence: ['killed relayer after Walrus upload', 'intent fulfilled after restart'],
      durationMs: 4200,
    },
    {
      name: 'sui-rpc-outage',
      description: 'Sui RPC outage recovers',
      status: 'fail',
      recovered: false,
      evidence: ['blocked Sui RPC for 30s'],
      error: 'no fulfillment within 120s of RPC restore',
      durationMs: 130000,
    },
  ],
};

test('renders a summary with totals', () => {
  const md = renderMarkdown(report);
  assert.match(md, /2 scenarios/);
  assert.match(md, /1 passed/);
  assert.match(md, /1 failed/);
});

test('renders each scenario with its status and evidence', () => {
  const md = renderMarkdown(report);
  assert.match(md, /relayer-crash-midflight/);
  assert.match(md, /intent fulfilled after restart/);
  assert.match(md, /sui-rpc-outage/);
  // The failing scenario surfaces its error.
  assert.match(md, /no fulfillment within 120s/);
});

test('marks pass and fail distinctly', () => {
  const md = renderMarkdown(report);
  // A reader must be able to tell pass from fail at a glance.
  assert.match(md, /PASS|✅/);
  assert.match(md, /FAIL|❌/);
});
