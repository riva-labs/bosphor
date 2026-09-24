/**
 * Pure statistics + report formatting for the relayer load generator
 * (scripts/loadgen.ts). No clocks, no I/O: every number in a report comes from
 * the samples passed in, and an empty sample set throws instead of printing a 0.
 */

/** Nearest-rank percentile over a pre-sorted ascending array (same as BenchmarkHarness). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) throw new Error('percentile of an empty sample set');
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx];
}

export interface LatencySummary {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  meanMs: number;
  maxMs: number;
}

export function summarize(samplesMs: number[]): LatencySummary {
  if (samplesMs.length === 0) throw new Error('no latency samples recorded');
  const s = [...samplesMs].sort((a, b) => a - b);
  return {
    count: s.length,
    p50Ms: percentile(s, 50),
    p95Ms: percentile(s, 95),
    p99Ms: percentile(s, 99),
    minMs: s[0],
    meanMs: s.reduce((a, b) => a + b, 0) / s.length,
    maxMs: s[s.length - 1],
  };
}

/** Completed intents per second over a wall-clock window. */
export function throughputPerSec(completed: number, windowMs: number): number {
  if (windowMs <= 0) throw new Error('throughput window must be positive');
  return (completed / windowMs) * 1000;
}

/** One load profile's result: a concurrency level driven through the pipeline. */
export interface ProfileResult {
  concurrency: number;
  intents: number;
  completed: number;
  failed: number;
  wallMs: number;
  throughputPerSec: number;
  /** Relayer compute latency (store span minus external I/O), per intent. */
  compute: LatencySummary;
  /** End-to-end store span (includes the stubbed I/O), per intent. */
  processing: LatencySummary;
}

const fmt = (n: number, digits = 1) => n.toFixed(digits);

/** Render results as a markdown table (the docs page embeds this verbatim). */
export function formatMarkdown(results: ProfileResult[]): string {
  const lines = [
    '| Concurrency | Intents | Failed | Wall (s) | Throughput (intents/s) | Compute mean (ms) | Compute p50 (ms) | Compute p95 (ms) | Compute p99 (ms) | Compute max (ms) | Store span p50 (ms) | Store span p95 (ms) |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  for (const r of results) {
    lines.push(
      `| ${r.concurrency} | ${r.intents} | ${r.failed} | ${fmt(r.wallMs / 1000, 2)} | ${fmt(r.throughputPerSec, 1)} | ${fmt(r.compute.meanMs, 3)} | ${fmt(r.compute.p50Ms, 2)} | ${fmt(r.compute.p95Ms, 2)} | ${fmt(r.compute.p99Ms, 2)} | ${fmt(r.compute.maxMs, 2)} | ${fmt(r.processing.p50Ms, 1)} | ${fmt(r.processing.p95Ms, 1)} |`,
    );
  }
  return lines.join('\n');
}

/** Parse `--key value` / `--flag` CLI arguments into a map. */
export function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`);
    const eq = a.indexOf('=');
    if (eq !== -1) {
      out.set(a.slice(2, eq), a.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      out.set(a.slice(2), argv[++i]);
    } else {
      out.set(a.slice(2), 'true');
    }
  }
  return out;
}

/** Parse a comma-separated list of positive integers, e.g. "1,10,50". */
export function parseIntList(value: string): number[] {
  const list = value.split(',').map((v) => Number(v.trim()));
  if (list.length === 0 || list.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`expected a comma-separated list of positive integers, got "${value}"`);
  }
  return list;
}

/**
 * A fixed latency plus uniform jitter in [0, jitterMs), drawn from a seeded
 * PRNG so a run is reproducible. Returns the delay in ms.
 */
export function makeLatency(baseMs: number, jitterMs: number, seed: number): () => number {
  let state = seed >>> 0 || 1;
  // mulberry32: tiny, deterministic, good enough for jitter.
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => baseMs + (jitterMs > 0 ? next() * jitterMs : 0);
}
