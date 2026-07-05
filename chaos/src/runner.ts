import type { RecoveryReport, Scenario, ScenarioResult } from './types.ts';

/**
 * Run each scenario in sequence and collect a consolidated recovery report.
 *
 * Scenarios run one at a time, never in parallel: they inject faults against a
 * single shared testnet system, so overlapping them would make their
 * observations meaningless. An unexpected throw from a scenario is caught and
 * recorded as a failing result, so a single broken scenario never aborts the
 * whole run.
 */
export async function runScenarios(
  scenarios: Scenario[],
  log: (msg: string) => void = () => {},
): Promise<RecoveryReport> {
  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    log(`[chaos] running ${scenario.name}: ${scenario.description}`);
    const start = Date.now();
    let result: ScenarioResult;
    try {
      const outcome = await scenario.run();
      result = {
        name: scenario.name,
        description: scenario.description,
        status: outcome.recovered ? 'pass' : 'fail',
        recovered: outcome.recovered,
        evidence: outcome.evidence,
        error: outcome.error,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      result = {
        name: scenario.name,
        description: scenario.description,
        status: 'fail',
        recovered: false,
        evidence: [],
        error: `unexpected error: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
    log(`[chaos] ${scenario.name}: ${result.status.toUpperCase()} (${result.durationMs}ms)`);
    results.push(result);
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    results,
  };
}
