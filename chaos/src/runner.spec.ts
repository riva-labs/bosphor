import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScenarios } from './runner.ts';
import type { Scenario } from './types.ts';

function scenario(name: string, run: Scenario['run']): Scenario {
  return { name, description: `${name} description`, run };
}

test('runs a passing scenario and reports a pass result', async () => {
  const s = scenario('ok', async () => ({ recovered: true, evidence: ['recovered fine'] }));

  const report = await runScenarios([s]);

  assert.equal(report.total, 1);
  assert.equal(report.passed, 1);
  assert.equal(report.failed, 0);
  assert.equal(report.results[0].name, 'ok');
  assert.equal(report.results[0].status, 'pass');
  assert.deepEqual(report.results[0].evidence, ['recovered fine']);
  assert.ok(report.results[0].durationMs >= 0);
});

test('marks a scenario that did not recover as a fail', async () => {
  const s = scenario('no-recover', async () => ({
    recovered: false,
    evidence: [],
    error: 'still down after 3 retries',
  }));

  const report = await runScenarios([s]);

  assert.equal(report.failed, 1);
  assert.equal(report.results[0].status, 'fail');
  assert.equal(report.results[0].error, 'still down after 3 retries');
});

test('catches an unexpected throw and turns it into a fail result', async () => {
  const s = scenario('boom', async () => {
    throw new Error('kaboom');
  });

  const report = await runScenarios([s]);

  assert.equal(report.failed, 1);
  assert.equal(report.results[0].status, 'fail');
  assert.match(report.results[0].error ?? '', /kaboom/);
});

test('runs every scenario sequentially, never in parallel', async () => {
  const active: number[] = [];
  let maxConcurrent = 0;
  const make = (name: string) =>
    scenario(name, async () => {
      active.push(1);
      maxConcurrent = Math.max(maxConcurrent, active.length);
      await new Promise((r) => setTimeout(r, 5));
      active.pop();
      return { recovered: true, evidence: [] };
    });

  const report = await runScenarios([make('a'), make('b'), make('c')]);

  assert.equal(report.total, 3);
  assert.equal(report.passed, 3);
  assert.equal(maxConcurrent, 1, 'scenarios must not overlap (shared testnet infra)');
});
