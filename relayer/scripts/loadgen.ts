/**
 * Relayer load generator (M4 evidence b: relayer performance).
 *
 * LOCAL mode (default): drives N synthetic, ready-to-store intents through the
 * REAL IntentProcessor claim loop at a given store concurrency. Only the
 * external I/O is stubbed (Walrus upload, Sui execute_store + wait, LayerZero
 * quote + send, WAL top-up) by configurable-latency fakes, and the Postgres
 * durable queue is replaced by an in-memory stand-in. Everything else is the
 * production code path: the claim tick, blob-id re-verification, per-step
 * idempotent store, lifecycle hops, and the IoClock compute-latency accounting
 * that feeds bosphor_relayer_compute_latency_seconds. The compute latency
 * reported here is captured from that exact metric call.
 *
 *   npx tsx scripts/loadgen.ts --concurrency 1,10,50 --intents 500
 *
 * What it measures, honestly: the relayer's own processing cost per intent
 * (store span minus external I/O) under concurrent load, and the throughput the
 * claim loop sustains given the stubbed I/O latencies. It does NOT measure
 * testnet chain, Walrus, or LayerZero latency; those are inputs (the --*-ms
 * flags), not outputs. Postgres round-trips are not modelled unless --db-ms is
 * set (they would count toward compute, making it larger).
 *
 * LIVE mode (--live, off by default): scrapes a running relayer's /metrics at
 * the start and end of a window and reports the compute-latency quantiles and
 * processed-intent throughput of ONLY the intents completed inside that window.
 * Load comes from real clients (canary, dApp, e2e scripts); optionally
 * `--drive "<cmd>" --drive-count N` spawns N copies of a command concurrently at
 * the start of the window (each must use its own wallet to avoid nonce races).
 *
 *   npx tsx scripts/loadgen.ts --live --metrics-url https://api.bosphor.xyz/testnet/metrics --window-s 900
 *
 * Output: a markdown table on stdout plus JSON (--out-json <file>, --out-md <file>).
 */
import 'reflect-metadata';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Logger } from '@nestjs/common';
import {
  formatMarkdown,
  parseArgs,
  parseIntList,
  ProfileResult,
  throughputPerSec,
} from './lib/loadgen-stats';
import { LocalOptions, runLocalProfile } from './lib/loadgen-local';
import {
  diffHistogram,
  histogramCount,
  histogramQuantileMs,
  parseHistogram,
  sumCounter,
} from './lib/prom-histogram';

const COMPUTE_METRIC = 'bosphor_relayer_compute_latency_seconds';
const PROCESSING_METRIC = 'bosphor_relayer_processing_latency_seconds';
const PROCESSED_METRIC = 'bosphor_relayer_intents_processed_total';

async function runLocal(args: Map<string, string>): Promise<void> {
  const num = (k: string, d: number) => {
    const v = args.has(k) ? Number(args.get(k)) : d;
    if (!Number.isFinite(v) || v < 0) throw new Error(`--${k} must be a non-negative number`);
    return v;
  };
  const concurrencies = parseIntList(args.get('concurrency') ?? '1,10,50');
  const o: LocalOptions = {
    intents: num('intents', 500),
    warmup: num('warmup', 50),
    blobBytes: num('blob-bytes', 1024),
    solanaShare: num('solana-share', 0),
    dbMs: num('db-ms', 0),
    jitterMs: num('jitter-ms', 0),
    seed: num('seed', 42),
    timeoutMs: num('timeout-s', 600) * 1000,
    latency: {
      walrusUpload: num('walrus-ms', 0),
      suiExecuteStore: num('sui-ms', 0),
      suiWait: num('sui-wait-ms', 0),
      lzQuote: num('lz-quote-ms', 0),
      lzSend: num('lz-send-ms', 0),
      walTopUp: num('wal-topup-ms', 0),
    },
  };
  if (!args.has('logs')) Logger.overrideLogger(false);

  // Warm the JIT and module caches so the first profile is not penalised; the
  // warmup run is discarded and never reported.
  if (o.warmup > 0) await runLocalProfile(Math.max(...concurrencies), o.warmup, o);

  const results: ProfileResult[] = [];
  for (const c of concurrencies) results.push(await runLocalProfile(c, o.intents, o));

  const meta = {
    mode: 'local-stubbed-io',
    note:
      'Real IntentProcessor with external I/O stubbed; compute = store span minus stubbed I/O (IoClock). ' +
      'Not a testnet measurement.',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    startedAt: new Date().toISOString(),
    options: { ...o, concurrencies, logs: args.has('logs') },
  };
  emit(args, { meta, results }, formatMarkdown(results));
}

async function scrape(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function runLive(args: Map<string, string>): Promise<void> {
  const url = args.get('metrics-url');
  if (!url) throw new Error('--live requires --metrics-url <relayer /metrics URL>');
  const windowS = Number(args.get('window-s') ?? 600);
  if (!(windowS > 0)) throw new Error('--window-s must be positive');

  const t0 = await scrape(url);
  const startedAt = Date.now();
  const drives: Promise<number>[] = [];
  const cmd = args.get('drive');
  if (cmd) {
    const n = Number(args.get('drive-count') ?? 1);
    console.error(`driving ${n} concurrent copies of: ${cmd}`);
    for (let i = 0; i < n; i++) {
      drives.push(
        new Promise((resolve) => {
          const child = spawn(cmd, { shell: true, stdio: 'inherit', env: { ...process.env, LOADGEN_WORKER: String(i) } });
          child.on('exit', (code) => resolve(code ?? 1));
        }),
      );
    }
  }
  console.error(`measuring for ${windowS}s against ${url} ...`);
  await new Promise((r) => setTimeout(r, windowS * 1000));
  const driveCodes = await Promise.all(drives);
  const t1 = await scrape(url);
  const wallMs = Date.now() - startedAt;

  const compute = diffHistogram(parseHistogram(t0, COMPUTE_METRIC), parseHistogram(t1, COMPUTE_METRIC));
  const processing = diffHistogram(parseHistogram(t0, PROCESSING_METRIC), parseHistogram(t1, PROCESSING_METRIC));
  const ok = sumCounter(t1, PROCESSED_METRIC, { result: 'success' }) - sumCounter(t0, PROCESSED_METRIC, { result: 'success' });
  const failed = sumCounter(t1, PROCESSED_METRIC, { result: 'failure' }) - sumCounter(t0, PROCESSED_METRIC, { result: 'failure' });
  const n = histogramCount(compute);
  if (n === 0) throw new Error('no intents completed inside the window; nothing to report');

  const q = (h: typeof compute, p: number) => Number(histogramQuantileMs(h, p).toFixed(1));
  const result = {
    meta: {
      mode: 'live',
      metricsUrl: url,
      windowS,
      wallMs,
      driveExitCodes: driveCodes,
      note: 'Quantiles are Prometheus-style bucket interpolations over the window delta.',
    },
    observations: n,
    succeeded: ok,
    failedAttempts: failed,
    throughputPerSec: Number(throughputPerSec(ok, wallMs).toFixed(3)),
    computeMs: { p50: q(compute, 0.5), p95: q(compute, 0.95), p99: q(compute, 0.99) },
    processingMs: { p50: q(processing, 0.5), p95: q(processing, 0.95), p99: q(processing, 0.99) },
  };
  const md = [
    '| Window (s) | Completed | Failed attempts | Throughput (intents/s) | Compute p50 (ms) | Compute p95 (ms) | Compute p99 (ms) | End-to-end p50 (ms) | End-to-end p95 (ms) |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    `| ${windowS} | ${ok} | ${failed} | ${result.throughputPerSec} | ${result.computeMs.p50} | ${result.computeMs.p95} | ${result.computeMs.p99} | ${result.processingMs.p50} | ${result.processingMs.p95} |`,
  ].join('\n');
  emit(args, result, md);
}

function emit(args: Map<string, string>, json: unknown, md: string): void {
  const text = JSON.stringify(json, null, 2);
  console.log(md);
  console.log('\n' + text);
  const jsonOut = args.get('out-json');
  if (jsonOut) writeFileSync(jsonOut, text + '\n');
  const mdOut = args.get('out-md');
  if (mdOut) writeFileSync(mdOut, md + '\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has('help')) {
    console.log(
      'Usage: npx tsx scripts/loadgen.ts [--concurrency 1,10,50] [--intents 500] [--warmup 50]\n' +
        '         [--walrus-ms 0] [--sui-ms 0] [--sui-wait-ms 0] [--lz-quote-ms 0] [--lz-send-ms 0]\n' +
        '         [--wal-topup-ms 0] [--jitter-ms 0] [--db-ms 0] [--solana-share 0] [--seed 42]\n' +
        '         [--logs] [--out-json f] [--out-md f]\n' +
        '       npx tsx scripts/loadgen.ts --live --metrics-url <url> [--window-s 600]\n' +
        '         [--drive "<cmd>" --drive-count N]',
    );
    return;
  }
  if (args.has('live')) await runLive(args);
  else await runLocal(args);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
