// The IntentProcessor transitively imports @solana/web3.js (heavy ESM); the
// load generator never touches Solana RPC, so stub it like the processor spec.
jest.mock('@solana/web3.js', () => ({
  Connection: class {},
  PublicKey: class {},
  Keypair: class {},
  Transaction: class {},
  TransactionInstruction: class {},
  sendAndConfirmTransaction: jest.fn(),
}));

import { Logger } from '@nestjs/common';
import {
  formatMarkdown,
  makeLatency,
  parseArgs,
  parseIntList,
  percentile,
  summarize,
  throughputPerSec,
} from './loadgen-stats';
import { InMemoryStagedStore } from './loadgen-fakes';
import { LocalOptions, runLocalProfile } from './loadgen-local';
import {
  diffHistogram,
  histogramCount,
  histogramQuantileMs,
  parseHistogram,
  sumCounter,
} from './prom-histogram';

describe('loadgen stats', () => {
  it('computes nearest-rank percentiles and a summary', () => {
    const s = summarize([5, 1, 4, 2, 3]);
    expect(s).toMatchObject({ count: 5, p50Ms: 3, p95Ms: 5, minMs: 1, maxMs: 5, meanMs: 3 });
    expect(percentile([1, 2, 3, 4], 50)).toBe(2);
  });

  it('never fabricates numbers for an empty sample set', () => {
    expect(() => summarize([])).toThrow(/no latency samples/);
    expect(() => percentile([], 50)).toThrow(/empty/);
    expect(() => throughputPerSec(10, 0)).toThrow(/positive/);
  });

  it('computes throughput over the wall window', () => {
    expect(throughputPerSec(50, 2000)).toBe(25);
  });

  it('parses CLI args and concurrency lists', () => {
    const a = parseArgs(['--concurrency', '1,10,50', '--live', '--out-json=x.json']);
    expect(a.get('concurrency')).toBe('1,10,50');
    expect(a.get('live')).toBe('true');
    expect(a.get('out-json')).toBe('x.json');
    expect(parseIntList('1, 10,50')).toEqual([1, 10, 50]);
    expect(() => parseIntList('1,0')).toThrow();
    expect(() => parseArgs(['stray'])).toThrow(/unexpected/);
  });

  it('draws reproducible seeded jitter within bounds', () => {
    const a = makeLatency(10, 5, 7);
    const b = makeLatency(10, 5, 7);
    const xs = Array.from({ length: 50 }, () => a());
    expect(xs).toEqual(Array.from({ length: 50 }, () => b()));
    expect(xs.every((x) => x >= 10 && x < 15)).toBe(true);
    expect(makeLatency(3, 0, 1)()).toBe(3);
  });

  it('formats a markdown row per profile', () => {
    const lat = { count: 1, p50Ms: 1, p95Ms: 2, p99Ms: 3, minMs: 0, meanMs: 1, maxMs: 4 };
    const md = formatMarkdown([
      { concurrency: 10, intents: 5, completed: 5, failed: 0, wallMs: 1000, throughputPerSec: 5, compute: lat, processing: lat },
    ]);
    expect(md.split('\n')).toHaveLength(3);
    expect(md).toMatch(/^\| Concurrency/);
    expect(md).toMatch(/\| 10 \| 5 \| 0 \| 1.00 \| 5.0 \|/);
  });
});

describe('prom-histogram', () => {
  const scrape = (b: number[], ok: number) =>
    [
      `bosphor_relayer_compute_latency_seconds_bucket{le="0.1"} ${b[0]}`,
      `bosphor_relayer_compute_latency_seconds_bucket{le="1"} ${b[1]}`,
      `bosphor_relayer_compute_latency_seconds_bucket{le="+Inf"} ${b[2]}`,
      `bosphor_relayer_intents_processed_total{result="success",path="sui_lz"} ${ok}`,
      `bosphor_relayer_intents_processed_total{path="evm",result="success"} 1`,
      `bosphor_relayer_intents_processed_total{result="failure",path="sui_lz"} 2`,
    ].join('\n');

  it('parses buckets and counters regardless of label order', () => {
    const t = scrape([4, 8, 10], 7);
    const h = parseHistogram(t, 'bosphor_relayer_compute_latency_seconds');
    expect(h.map((x) => x.le)).toEqual([0.1, 1, Infinity]);
    expect(histogramCount(h)).toBe(10);
    expect(sumCounter(t, 'bosphor_relayer_intents_processed_total', { result: 'success' })).toBe(8);
    expect(sumCounter(t, 'bosphor_relayer_intents_processed_total', { result: 'failure' })).toBe(2);
    expect(sumCounter(t, 'missing_total')).toBe(0);
  });

  it('diffs two scrapes to the window-only histogram and interpolates quantiles', () => {
    const before = parseHistogram(scrape([4, 8, 10], 0), 'bosphor_relayer_compute_latency_seconds');
    const after = parseHistogram(scrape([14, 18, 20], 0), 'bosphor_relayer_compute_latency_seconds');
    const d = diffHistogram(before, after);
    expect(d.map((x) => x.cumulative)).toEqual([10, 10, 10]);
    // All 10 window observations fall in the first bucket (0, 0.1s].
    expect(histogramQuantileMs(d, 0.5)).toBeCloseTo(50, 5);
  });

  it('rejects a restarted relayer and an empty window', () => {
    const hi = parseHistogram(scrape([4, 8, 10], 0), 'bosphor_relayer_compute_latency_seconds');
    const lo = parseHistogram(scrape([1, 1, 1], 0), 'bosphor_relayer_compute_latency_seconds');
    expect(() => diffHistogram(hi, lo)).toThrow(/backwards/);
    expect(() => histogramQuantileMs(diffHistogram(hi, hi), 0.5)).toThrow(/no observations/);
  });
});

describe('InMemoryStagedStore', () => {
  it('drains due active rows in seed (FIFO) order as snapshots', async () => {
    const s = new InMemoryStagedStore();
    const base = {
      received: true,
      hasBytes: true,
      returned: false,
      state: 'active' as const,
      attempts: 0,
      updatedAt: 0,
    };
    s.seed({ ...base, intentId: 'later', nextAttemptAt: 10_000, createdAt: 0 }, Buffer.from('c'));
    s.seed({ ...base, intentId: 'a', nextAttemptAt: 0, createdAt: 1 }, Buffer.from('a'));
    s.seed({ ...base, intentId: 'b', nextAttemptAt: 0, createdAt: 2 }, Buffer.from('b'));
    const rows = await s.drainDue(5_000, 10);
    expect(rows.map((r) => r.intentId)).toEqual(['a', 'b']);
    rows[0].state = 'dead';
    expect(s.rows.get('a')!.state).toBe('active');
    await s.markDone('a');
    expect(s.count('done')).toBe(1);
    expect(s.count('active')).toBe(2);
    expect((await s.drainDue(5_000, 10)).map((r) => r.intentId)).toEqual(['b']);
    await s.freeBytes('a');
    expect(await s.fetchBytes('a')).toBeUndefined();
  });
});

describe('runLocalProfile (real IntentProcessor, stubbed I/O)', () => {
  beforeAll(() => Logger.overrideLogger(false));

  const opts = (walrusMs: number): LocalOptions => ({
    intents: 0,
    warmup: 0,
    blobBytes: 64,
    solanaShare: 0.5,
    dbMs: 0,
    jitterMs: 0,
    seed: 1,
    timeoutMs: 20_000,
    latency: { walrusUpload: walrusMs, suiExecuteStore: 0, suiWait: 0, lzQuote: 0, lzSend: 0, walTopUp: 0 },
  });

  it('settles every seeded intent and records one compute sample each', async () => {
    const r = await runLocalProfile(4, 12, opts(0));
    expect(r.completed).toBe(12);
    expect(r.failed).toBe(0);
    expect(r.compute.count).toBe(12);
    expect(r.processing.count).toBe(12);
  });

  it('subtracts stubbed I/O from compute via IoClock', async () => {
    const r = await runLocalProfile(2, 4, opts(40));
    // The store span includes the 40ms fake upload; compute does not.
    expect(r.processing.minMs).toBeGreaterThanOrEqual(35);
    expect(r.compute.maxMs).toBeLessThan(r.processing.minMs);
  });
});
