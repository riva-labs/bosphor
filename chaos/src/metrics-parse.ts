/**
 * Sum every reason-labelled series of the canary's skip counter
 * (`bosphor_canary_skipped_total{reason="..."}`) from a Prometheus text
 * exposition. Returns 0 when the counter is not present.
 */
export function parseCanarySkipCount(metricsText: string): number {
  let total = 0;
  for (const line of metricsText.split('\n')) {
    if (line.startsWith('#')) continue;
    if (!line.startsWith('bosphor_canary_skipped_total')) continue;
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) total += value;
  }
  return total;
}
