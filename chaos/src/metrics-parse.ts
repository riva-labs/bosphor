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

/**
 * Sum every series whose name starts with `metricName` from a Prometheus text
 * exposition (handles both the bare counter and any labelled variants). Returns
 * 0 when the metric is absent. Used to read the relayer's break-even-skip and
 * negative-margin counters.
 */
export function parseCounter(metricsText: string, metricName: string): number {
  let total = 0;
  for (const line of metricsText.split('\n')) {
    if (line.startsWith('#')) continue;
    if (!line.startsWith(metricName)) continue;
    // Guard against a prefix collision (e.g. foo vs foo_total): the char after
    // the name must be a space or a label brace, not another name character.
    const next = line.charAt(metricName.length);
    if (next !== '' && next !== ' ' && next !== '{') continue;
    const value = Number(line.trim().split(/\s+/).pop());
    if (Number.isFinite(value)) total += value;
  }
  return total;
}
