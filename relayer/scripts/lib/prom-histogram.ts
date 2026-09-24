/**
 * Minimal Prometheus text-exposition helpers shared by the benchmark and the
 * load generator's --live mode. Pure (no I/O) so they are unit-tested.
 */

/** One cumulative Prometheus histogram bucket: upper bound `le` (seconds) and count. */
export interface HistBucket {
  le: number;
  cumulative: number;
}

/** Parse an unlabelled histogram's buckets from Prometheus text exposition. */
export function parseHistogram(text: string, metric: string): HistBucket[] {
  const buckets: HistBucket[] = [];
  const re = new RegExp(`^${metric}_bucket\\{le="([^"]+)"\\}\\s+([0-9.eE+-]+)`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    buckets.push({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), cumulative: Number(m[2]) });
  }
  return buckets.sort((a, b) => a.le - b.le);
}

/**
 * Sum every series of a counter whose labels include all of `match`
 * (label order in the exposition does not matter). Returns 0 if absent.
 */
export function sumCounter(text: string, metric: string, match: Record<string, string> = {}): number {
  const re = new RegExp(`^${metric}(?:\\{([^}]*)\\})?\\s+([0-9.eE+-]+)`, 'gm');
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const labels: Record<string, string> = {};
    for (const pair of (m[1] ?? '').matchAll(/(\w+)="([^"]*)"/g)) labels[pair[1]] = pair[2];
    if (Object.entries(match).every(([k, v]) => labels[k] === v)) total += Number(m[2]);
  }
  return total;
}

/**
 * Bucket-wise difference `after - before`, i.e. the histogram of only the
 * observations made between two scrapes. Throws if the buckets do not line up
 * or a count went backwards (the relayer restarted mid-window).
 */
export function diffHistogram(before: HistBucket[], after: HistBucket[]): HistBucket[] {
  if (before.length === 0) return after;
  if (before.length !== after.length || before.some((b, i) => b.le !== after[i].le)) {
    throw new Error('histogram bucket layout changed between scrapes');
  }
  return after.map((a, i) => {
    const cumulative = a.cumulative - before[i].cumulative;
    if (cumulative < 0) throw new Error('histogram count went backwards (relayer restarted?)');
    return { le: a.le, cumulative };
  });
}

/** Total observation count of a cumulative histogram (the +Inf bucket). */
export function histogramCount(buckets: HistBucket[]): number {
  return buckets.length ? buckets[buckets.length - 1].cumulative : 0;
}

/**
 * Estimate a quantile from cumulative histogram buckets, matching Prometheus
 * histogram_quantile: linear interpolation within the bucket that crosses the
 * rank. Returns milliseconds (buckets are in seconds). Throws on an empty
 * histogram rather than returning a fabricated 0.
 */
export function histogramQuantileMs(buckets: HistBucket[], q: number): number {
  const total = histogramCount(buckets);
  if (total <= 0) throw new Error('histogram has no observations (count=0)');
  const rank = q * total;
  let lowerBound = 0;
  let lowerCumulative = 0;
  for (const b of buckets) {
    if (b.cumulative >= rank) {
      if (!Number.isFinite(b.le)) return lowerBound * 1000; // +Inf bucket: no upper edge
      const span = b.cumulative - lowerCumulative;
      const frac = span > 0 ? (rank - lowerCumulative) / span : 0;
      return (lowerBound + (b.le - lowerBound) * frac) * 1000;
    }
    lowerBound = b.le;
    lowerCumulative = b.cumulative;
  }
  return lowerBound * 1000;
}
