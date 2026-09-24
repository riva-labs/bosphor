/**
 * Bosphor KPI export.
 *
 * Prints a verifiable usage package for a time window, as JSON and markdown:
 *   - Walrus storage ops from the durable ops ledger (storage_op_ledger): total,
 *     by origin chain, total bytes, unique senders, unique app ids, ops per app.
 *   - Relayer compute latency p50 / p95 from Prometheus (the <3s KPI metric).
 *   - npm downloads of @bosphor/sdk from the public npm API.
 *
 * Usage:
 *   DATABASE_URL=postgres://... PROMETHEUS_URL=http://localhost:9091 \
 *     npm run kpi -- --since 2026-09-01 [--until 2026-10-01] [--network testnet] \
 *                    [--format both|json|md]
 *
 * Env:
 *   DATABASE_URL         Postgres holding storage_op_ledger (required for ops).
 *   PROMETHEUS_URL       Prometheus base URL (optional; latency is unavailable without it).
 *   PROMETHEUS_SELECTOR  Optional label matcher, e.g. deployment="testnet".
 *   NPM_PACKAGE          Package to count downloads for (default @bosphor/sdk).
 *
 * This script never loads a .env file on its own: point it at the database you
 * mean to report on. Every source that cannot be read is reported as
 * "unavailable" with the reason. No number is ever estimated or filled in.
 */
import { Pool } from 'pg';
import { StorageOpLedgerStore } from '../src/ledger/storage-op-ledger.store';
import {
  KpiReport,
  Maybe,
  aggregateLedger,
  available,
  latencyQuantileQuery,
  LedgerKpis,
  parsePromScalar,
  renderKpiMarkdown,
  sumNpmDownloads,
  unavailable,
} from '../src/kpi/kpi';

interface Args {
  since: number;
  until: number;
  network: string | null;
  format: 'both' | 'json' | 'md';
}

/** Parse an ISO date/time or epoch milliseconds. */
function parseTime(raw: string, flag: string): number {
  const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`${flag}: cannot parse time "${raw}"`);
  return ms;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new Error(`${flag} needs a value`);
    return v;
  };
  const sinceRaw = get('--since');
  if (!sinceRaw) throw new Error('--since is required (ISO date or epoch ms)');
  const since = parseTime(sinceRaw, '--since');
  const untilRaw = get('--until');
  const until = untilRaw ? parseTime(untilRaw, '--until') : Date.now();
  if (until <= since) throw new Error('--until must be after --since');
  const format = (get('--format') ?? 'both') as Args['format'];
  if (!['both', 'json', 'md'].includes(format)) throw new Error('--format: both | json | md');
  return { since, until, network: get('--network') ?? null, format };
}

async function readLedger(args: Args): Promise<Maybe<LedgerKpis>> {
  const url = process.env.DATABASE_URL;
  if (!url) return unavailable('DATABASE_URL not set');
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const store = new StorageOpLedgerStore(pool);
    const all = await store.listStoredBetween(args.since, args.until);
    const entries = args.network ? all.filter((e) => e.network === args.network) : all;
    return available(aggregateLedger(entries));
  } catch (err) {
    return unavailable(`ledger query failed: ${(err as Error).message}`);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function promQuery(base: string, query: string, time: number): Promise<number | null> {
  const url = new URL('/api/v1/query', base);
  url.searchParams.set('query', query);
  url.searchParams.set('time', String(time / 1000));
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`prometheus returned ${res.status}`);
  return parsePromScalar(await res.json());
}

async function readLatency(args: Args): Promise<Maybe<{ p50: number; p95: number }>> {
  const base = process.env.PROMETHEUS_URL;
  if (!base) return unavailable('PROMETHEUS_URL not set');
  const windowSeconds = (args.until - args.since) / 1000;
  const selector = process.env.PROMETHEUS_SELECTOR ?? '';
  try {
    const p50 = await promQuery(
      base,
      latencyQuantileQuery(0.5, windowSeconds, selector),
      args.until,
    );
    const p95 = await promQuery(
      base,
      latencyQuantileQuery(0.95, windowSeconds, selector),
      args.until,
    );
    if (p50 === null || p95 === null) {
      return unavailable('no compute-latency observations in Prometheus for this window');
    }
    return available({ p50, p95 });
  } catch (err) {
    return unavailable(`prometheus query failed: ${(err as Error).message}`);
  }
}

async function readNpmDownloads(
  args: Args,
): Promise<Maybe<{ package: string; downloads: number }>> {
  const pkg = process.env.NPM_PACKAGE ?? '@bosphor/sdk';
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  // The window's `until` is exclusive; npm ranges are inclusive whole days.
  const range = `${day(args.since)}:${day(args.until - 1)}`;
  try {
    const res = await fetch(`https://api.npmjs.org/downloads/range/${range}/${pkg}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return unavailable(`npm API returned ${res.status}`);
    return available({ package: pkg, downloads: sumNpmDownloads(await res.json()) });
  } catch (err) {
    return unavailable(`npm API request failed: ${(err as Error).message}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const [ledger, computeLatencySeconds, npmDownloads] = await Promise.all([
    readLedger(args),
    readLatency(args),
    readNpmDownloads(args),
  ]);
  const report: KpiReport = {
    window: {
      since: new Date(args.since).toISOString(),
      until: new Date(args.until).toISOString(),
    },
    network: args.network,
    ledger,
    computeLatencySeconds,
    npmDownloads,
  };
  if (args.format !== 'md') process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (args.format === 'both') process.stdout.write('\n');
  if (args.format !== 'json') process.stdout.write(renderKpiMarkdown(report) + '\n');
}

main().catch((err) => {
  process.stderr.write(`kpi: ${(err as Error).message}\n`);
  process.exit(1);
});
