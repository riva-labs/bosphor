/**
 * Relayer processing-latency benchmark harness.
 *
 * It records one sample per intent: the moment the relayer OBSERVED the intent as
 * ready to store, and the moment its store work COMPLETED. From those it computes
 * median and tail latency and throughput, and formats a report.
 *
 * IMPORTANT: the measured metric is the relayer's own PROCESSING time
 * (observe -> work-complete), NOT the full LayerZero round-trip. The cross-chain
 * round-trip is dominated by DVN/executor delivery (minutes) and is out of the
 * relayer's control; the <3s target is about how fast the relayer reacts once it
 * can act. Pure and deterministic (no clocks of its own).
 */

export interface LatencySample {
  intentId: string;
  /** When the relayer observed the intent ready to store (epoch ms). */
  observedAtMs: number;
  /** When the store work completed (epoch ms). */
  completedAtMs: number;
}

export interface BenchmarkReport {
  count: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  /** Intents completed per second over the observed-to-completed wall-clock span. */
  throughputPerSec: number;
  /** Wall-clock span from the first observation to the last completion (ms). */
  windowMs: number;
  targetMs: number;
  /** Whether median processing latency met the target. */
  medianUnderTarget: boolean;
}

export class BenchmarkHarness {
  private samples: LatencySample[] = [];

  constructor(private readonly targetMs: number = 3000) {}

  /** Record one intent's processing latency. Rejects an out-of-order sample. */
  record(sample: LatencySample): void {
    if (
      !Number.isFinite(sample.observedAtMs) ||
      !Number.isFinite(sample.completedAtMs) ||
      sample.completedAtMs < sample.observedAtMs
    ) {
      throw new Error(`BenchmarkHarness: invalid sample for ${sample.intentId}`);
    }
    this.samples.push(sample);
  }

  reset(): void {
    this.samples = [];
  }

  get size(): number {
    return this.samples.length;
  }

  report(): BenchmarkReport {
    if (this.samples.length === 0) {
      throw new Error('BenchmarkHarness: no samples recorded');
    }
    const durations = this.samples
      .map((s) => s.completedAtMs - s.observedAtMs)
      .sort((a, b) => a - b);

    const p50 = percentile(durations, 50);
    const firstObserved = Math.min(...this.samples.map((s) => s.observedAtMs));
    const lastCompleted = Math.max(...this.samples.map((s) => s.completedAtMs));
    const windowMs = lastCompleted - firstObserved;
    const throughputPerSec = windowMs > 0 ? (this.samples.length / windowMs) * 1000 : this.samples.length;

    return {
      count: this.samples.length,
      p50Ms: p50,
      p95Ms: percentile(durations, 95),
      p99Ms: percentile(durations, 99),
      minMs: durations[0],
      maxMs: durations[durations.length - 1],
      meanMs: durations.reduce((a, b) => a + b, 0) / durations.length,
      throughputPerSec,
      windowMs,
      targetMs: this.targetMs,
      medianUnderTarget: p50 < this.targetMs,
    };
  }

  /** Human-readable report for the status report / CI log. */
  formatReport(): string {
    const r = this.report();
    return [
      'Relayer processing-latency benchmark (observe -> work-complete, NOT the LZ round-trip)',
      `  samples:      ${r.count}`,
      `  p50:          ${r.p50Ms.toFixed(0)} ms`,
      `  p95:          ${r.p95Ms.toFixed(0)} ms`,
      `  p99:          ${r.p99Ms.toFixed(0)} ms`,
      `  min/mean/max: ${r.minMs.toFixed(0)} / ${r.meanMs.toFixed(0)} / ${r.maxMs.toFixed(0)} ms`,
      `  throughput:   ${r.throughputPerSec.toFixed(2)} intents/s`,
      `  target:       median < ${r.targetMs} ms -> ${r.medianUnderTarget ? 'PASS' : 'FAIL'}`,
    ].join('\n');
  }
}

/** Nearest-rank percentile over a pre-sorted ascending array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(Math.max(rank, 1), sorted.length) - 1;
  return sorted[idx];
}
