import { BenchmarkHarness } from './benchmark-harness';

describe('BenchmarkHarness', () => {
  it('computes median and tail processing latency', () => {
    const h = new BenchmarkHarness(3000);
    // durations: 900, 1000, 1500, 2000, 2500 ms
    const base = 1_000_000;
    for (const [i, dur] of [900, 1000, 1500, 2000, 2500].entries()) {
      h.record({ intentId: `0x${i}`, observedAtMs: base, completedAtMs: base + dur });
    }
    const r = h.report();
    expect(r.count).toBe(5);
    expect(r.p50Ms).toBe(1500);
    expect(r.p95Ms).toBe(2500);
    expect(r.minMs).toBe(900);
    expect(r.maxMs).toBe(2500);
    expect(r.medianUnderTarget).toBe(true);
  });

  it('flags when median processing latency exceeds the target', () => {
    const h = new BenchmarkHarness(1000);
    h.record({ intentId: '0xa', observedAtMs: 0, completedAtMs: 2000 });
    h.record({ intentId: '0xb', observedAtMs: 0, completedAtMs: 2500 });
    expect(h.report().medianUnderTarget).toBe(false);
  });

  it('computes throughput over the observe-to-complete window', () => {
    const h = new BenchmarkHarness();
    // 4 intents completing within a 2s window -> 2 intents/s.
    h.record({ intentId: '0x1', observedAtMs: 0, completedAtMs: 500 });
    h.record({ intentId: '0x2', observedAtMs: 200, completedAtMs: 1000 });
    h.record({ intentId: '0x3', observedAtMs: 400, completedAtMs: 1500 });
    h.record({ intentId: '0x4', observedAtMs: 600, completedAtMs: 2000 });
    expect(h.report().throughputPerSec).toBeCloseTo(2, 5);
  });

  it('rejects an out-of-order sample (completed before observed)', () => {
    const h = new BenchmarkHarness();
    expect(() => h.record({ intentId: '0x', observedAtMs: 100, completedAtMs: 50 })).toThrow(
      /invalid sample/,
    );
  });

  it('throws when reporting with no samples (never fabricates numbers)', () => {
    expect(() => new BenchmarkHarness().report()).toThrow(/no samples/);
  });

  it('formats a report labelled as processing time, not the LZ round-trip', () => {
    const h = new BenchmarkHarness();
    h.record({ intentId: '0x1', observedAtMs: 0, completedAtMs: 1200 });
    const text = h.formatReport();
    expect(text).toMatch(/processing-latency/);
    expect(text).toMatch(/NOT the LZ round-trip/);
    expect(text).toMatch(/PASS/);
  });
});
