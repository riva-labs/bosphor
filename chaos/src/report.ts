import { writeFile } from 'node:fs/promises';
import type { RecoveryReport } from './types.ts';

/**
 * Render a chaos recovery report as Markdown, suitable for pasting into the
 * Milestone status report. Pass/fail is shown with both an icon and a word so
 * it reads clearly in rendered and plain-text views.
 */
export function renderMarkdown(report: RecoveryReport): string {
  const lines: string[] = [];
  lines.push('# Bosphor Chaos Recovery Report');
  lines.push('');
  lines.push(
    `${report.total} scenarios: ${report.passed} passed, ${report.failed} failed.`,
  );
  lines.push('');

  for (const r of report.results) {
    const badge = r.status === 'pass' ? '✅ PASS' : '❌ FAIL';
    lines.push(`## ${badge} — ${r.name}`);
    lines.push('');
    lines.push(r.description);
    lines.push('');
    lines.push(`Duration: ${(r.durationMs / 1000).toFixed(1)}s`);
    if (r.error) {
      lines.push('');
      lines.push(`Error: ${r.error}`);
    }
    if (r.evidence.length > 0) {
      lines.push('');
      lines.push('Evidence:');
      for (const e of r.evidence) lines.push(`- ${e}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Write the report to disk as both Markdown and JSON at the given path prefix,
 * e.g. `recovery-report` -> `recovery-report.md` + `recovery-report.json`.
 */
export async function writeReport(report: RecoveryReport, pathPrefix: string): Promise<void> {
  await writeFile(`${pathPrefix}.md`, renderMarkdown(report), 'utf8');
  await writeFile(`${pathPrefix}.json`, JSON.stringify(report, null, 2), 'utf8');
}
