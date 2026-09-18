/**
 * Relayer latency benchmark runner.
 *
 * Two latency figures exist (see #411 and website/docs/relayer.md "Latency metrics"):
 *   - COMPUTE latency  (bosphor_relayer_compute_latency_seconds): the relayer's
 *     own reaction time, i.e. the store span MINUS external chain/Walrus/LZ I/O.
 *     THIS is the M4 <3s KPI.
 *   - end-to-end/processing latency (bosphor_relayer_processing_latency_seconds):
 *     observe -> work-complete, dominated by testnet chain + Walrus I/O (~10-30s).
 *     Reported openly as a gauge, NOT the KPI.
 *
 * Modes (checked in order):
 *   1. BENCH_METRICS_URL   -> scrape a live relayer's /metrics and report the
 *      REAL compute-latency histogram quantiles vs the target. This is the
 *      honest KPI measurement; use it for the deliverable.
 *   2. BENCH_SAMPLES_FILE  -> a JSON array of {intentId, observedAtMs,
 *      completedAtMs} real samples through the harness.
 *   3. (default)           -> a SYNTHETIC smoke run. It is a CI floor that
 *      exercises the harness; it is explicitly NOT the live KPI result and is
 *      labelled as such. It fabricates samples, so never quote it as evidence.
 *
 * Run: npx tsx scripts/benchmark.ts
 */
import { readFileSync } from 'node:fs';
import { BenchmarkHarness, LatencySample } from '../src/intent/benchmark-harness';

const COMPUTE_METRIC = 'bosphor_relayer_compute_latency_seconds';

function syntheticSamples(count = 200): LatencySample[] {
  // A representative spread of relayer COMPUTE latencies (store span minus
  // external I/O): mostly sub-second reuse/verify paths, a short tail.
  const spread = [50, 90, 120, 180, 250, 320, 450, 600, 900, 1400];
  const base = 1_000_000;
  return Array.from({ length: count }, (_, i) => {
    const dur = spread[i % spread.length];
    const observedAtMs = base + i * 50; // ~20 intents/s arrival
    return { intentId: `0x${i.toString(16)}`, observedAtMs, completedAtMs: observedAtMs + dur };
  });
}

function loadSamples(file: string): LatencySample[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as LatencySample[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`BENCH_SAMPLES_FILE ${file} did not contain a non-empty samples array`);
  }
  return parsed;
}

/** One cumulative Prometheus histogram bucket: upper bound `le` and count. */
interface HistBucket {
  le: number;
  cumulative: number;
}

/** Parse a metric's histogram buckets from Prometheus text exposition. */
function parseHistogram(text: string, metric: string): HistBucket[] {
  const buckets: HistBucket[] = [];
  const re = new RegExp(`^${metric}_bucket\\{le="([^"]+)"\\}\\s+([0-9.eE+-]+)`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    buckets.push({ le: m[1] === '+Inf' ? Infinity : Number(m[1]), cumulative: Number(m[2]) });
  }
  return buckets.sort((a, b) => a.le - b.le);
}

/**
 * Estimate a quantile from cumulative histogram buckets, matching Prometheus
 * histogram_quantile: linear interpolation within the bucket that crosses the
 * rank. Returns milliseconds (buckets are in seconds).
 */
function histogramQuantileMs(buckets: HistBucket[], q: number): number {
  const total = buckets.length ? buckets[buckets.length - 1].cumulative : 0;
  if (total <= 0) throw new Error(`${COMPUTE_METRIC} has no observations yet (count=0)`);
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

async function runMetricsMode(url: string, targetMs: number): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  const text = await res.text();
  const buckets = parseHistogram(text, COMPUTE_METRIC);
  if (buckets.length === 0) {
    throw new Error(`${COMPUTE_METRIC}_bucket not found at ${url}; is the relayer built with it?`);
  }
  const count = buckets[buckets.length - 1].cumulative;
  const p50 = histogramQuantileMs(buckets, 0.5);
  const p95 = histogramQuantileMs(buckets, 0.95);
  const p99 = histogramQuantileMs(buckets, 0.99);
  const pass = p50 < targetMs;

  console.log(
    [
      `Relayer COMPUTE-latency KPI (live ${COMPUTE_METRIC} from ${url})`,
      `  observations: ${count}`,
      `  p50:          ${p50.toFixed(0)} ms`,
      `  p95:          ${p95.toFixed(0)} ms`,
      `  p99:          ${p99.toFixed(0)} ms`,
      `  target:       median < ${targetMs} ms -> ${pass ? 'PASS' : 'FAIL'}`,
    ].join('\n'),
  );
  if (!pass) {
    console.error(`\nFAIL: live median compute latency ${p50.toFixed(0)}ms exceeds ${targetMs}ms`);
    process.exit(1);
  }
}

function runSampleMode(samples: LatencySample[], targetMs: number, synthetic: boolean): void {
  const harness = new BenchmarkHarness(targetMs);
  for (const s of samples) harness.record(s);
  const report = harness.report();
  if (synthetic) {
    console.log(
      'SYNTHETIC CI FLOOR - exercises the harness only. NOT the live KPI.\n' +
        'For the real KPI set BENCH_METRICS_URL to a live relayer /metrics endpoint.\n',
    );
  }

  console.log(harness.formatReport());
  if (!report.medianUnderTarget) {
    console.error(`\nFAIL: median ${report.p50Ms}ms exceeds target ${targetMs}ms`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const targetMs = Number(process.env.BENCH_TARGET_MS ?? 3000);
  const metricsUrl = process.env.BENCH_METRICS_URL;
  const samplesFile = process.env.BENCH_SAMPLES_FILE;

  if (metricsUrl) {
    await runMetricsMode(metricsUrl, targetMs);
  } else if (samplesFile) {
    runSampleMode(loadSamples(samplesFile), targetMs, false);
  } else {
    runSampleMode(syntheticSamples(), targetMs, true);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
