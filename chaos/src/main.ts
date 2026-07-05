import { config } from 'dotenv';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
config({ path: resolve(import.meta.dirname, '../../.env') });

import { runScenarios } from './runner.ts';
import { renderMarkdown, writeReport } from './report.ts';
import { allScenarios } from './scenarios.ts';
import { makeRealDeps } from './real-deps.ts';

/**
 * Run the chaos harness on demand:
 *
 *   npm run chaos                       # run all scenarios
 *   npm run chaos deadline-expiry-skip  # run a named subset
 *
 * Emits a recovery report (Markdown + JSON) under chaos/reports/ and exits
 * non-zero if any scenario failed to recover.
 */
async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const deps = makeRealDeps();

  let scenarios = allScenarios(deps);
  if (requested.length > 0) {
    scenarios = scenarios.filter((s) => requested.includes(s.name));
    const unknown = requested.filter((n) => !allScenarios(deps).some((s) => s.name === n));
    if (unknown.length > 0) {
      console.error(`[chaos] unknown scenarios: ${unknown.join(', ')}`);
      process.exit(2);
    }
  }

  console.log(`[chaos] running ${scenarios.length} scenario(s)`);
  const report = await runScenarios(scenarios, (m) => console.log(m));

  const reportsDir = resolve(import.meta.dirname, '../reports');
  await mkdir(reportsDir, { recursive: true });
  const prefix = resolve(reportsDir, `recovery-report-${Date.now()}`);
  await writeReport(report, prefix);

  console.log('\n' + renderMarkdown(report));
  console.log(`[chaos] report written to ${prefix}.md and ${prefix}.json`);

  if (report.failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`[chaos] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
