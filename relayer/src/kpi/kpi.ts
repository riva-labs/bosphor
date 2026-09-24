/**
 * KPI aggregation for the durable ops ledger (storage_op_ledger).
 *
 * Pure functions only: the export script (scripts/kpi.ts) does the I/O
 * (Postgres, Prometheus, npm) and hands the results here. Every figure is
 * derived from real data; a source that could not be read is carried as
 * `unavailable` and printed as such, never replaced by a guess or a zero.
 */
import { StorageOpEntry } from '../ledger/storage-op-ledger.types';

/** Human names for LayerZero v2 endpoint ids seen as origin chains. */
export const EID_NAMES: Readonly<Record<number, string>> = {
  // Mainnets
  30101: 'ethereum',
  30102: 'bsc',
  30106: 'avalanche',
  30109: 'polygon',
  30110: 'arbitrum',
  30111: 'optimism',
  30168: 'solana',
  30184: 'base',
  30378: 'sui',
  // Testnets
  40161: 'sepolia',
  40168: 'solana-devnet',
  40231: 'arbitrum-sepolia',
  40232: 'optimism-sepolia',
  40245: 'base-sepolia',
  40378: 'sui-testnet',
};

/** Chain name for an EID, `eid-<n>` for one not in the table, `unknown` for none. */
export function eidName(eid: number | null | undefined): string {
  if (eid === null || eid === undefined) return 'unknown';
  return EID_NAMES[eid] ?? `eid-${eid}`;
}

/** A value that may be missing because its source could not be read. */
export type Maybe<T> = { available: true; value: T } | { available: false; reason: string };

export const available = <T>(value: T): Maybe<T> => ({ available: true, value });
export const unavailable = <T = never>(reason: string): Maybe<T> => ({ available: false, reason });

export interface ChainKpi {
  srcEid: number | null;
  chain: string;
  ops: number;
  bytes: number;
}

export interface AppKpi {
  /** The integrator app id, or `none` for ops sent without X-Bosphor-App. */
  appId: string;
  ops: number;
  bytes: number;
}

export interface LedgerKpis {
  totalOps: number;
  totalBytes: number;
  uniqueSenders: number;
  /** Distinct integrator app ids (ops without one are not an app). */
  uniqueAppIds: number;
  opsByChain: ChainKpi[];
  opsByApp: AppKpi[];
}

export interface KpiReport {
  window: { since: string; until: string };
  network: string | null;
  ledger: Maybe<LedgerKpis>;
  computeLatencySeconds: Maybe<{ p50: number; p95: number }>;
  npmDownloads: Maybe<{ package: string; downloads: number }>;
}

/**
 * Normalise a sender for uniqueness: EVM hex addresses are case-insensitive, so
 * they are lower-cased; anything else (Solana base58) is case-sensitive and kept.
 */
export function normaliseSender(sender: string): string {
  return /^0x[0-9a-f]+$/i.test(sender) ? sender.toLowerCase() : sender;
}

/** Aggregate ledger entries (already filtered to the window) into KPIs. */
export function aggregateLedger(entries: readonly StorageOpEntry[]): LedgerKpis {
  const chains = new Map<string, ChainKpi>();
  const apps = new Map<string, AppKpi>();
  const senders = new Set<string>();
  let totalBytes = 0;

  for (const e of entries) {
    const bytes = e.size ?? 0;
    totalBytes += bytes;
    if (e.sender) senders.add(normaliseSender(e.sender));

    const chainKey = String(e.srcEid);
    const chain = chains.get(chainKey) ?? {
      srcEid: e.srcEid,
      chain: eidName(e.srcEid),
      ops: 0,
      bytes: 0,
    };
    chain.ops++;
    chain.bytes += bytes;
    chains.set(chainKey, chain);

    const appKey = e.appId ?? 'none';
    const app = apps.get(appKey) ?? { appId: appKey, ops: 0, bytes: 0 };
    app.ops++;
    app.bytes += bytes;
    apps.set(appKey, app);
  }

  const byOpsDesc = <T extends { ops: number }>(a: T, b: T) => b.ops - a.ops;
  return {
    totalOps: entries.length,
    totalBytes,
    uniqueSenders: senders.size,
    uniqueAppIds: [...apps.keys()].filter((k) => k !== 'none').length,
    opsByChain: [...chains.values()].sort(byOpsDesc),
    opsByApp: [...apps.values()].sort(byOpsDesc),
  };
}

/**
 * Sum an npm downloads/range response
 * (`{ downloads: [{ day, downloads }], package }`). Throws on an unexpected
 * shape so the caller reports `unavailable` instead of a made-up number.
 */
export function sumNpmDownloads(body: unknown): number {
  const days = (body as { downloads?: unknown })?.downloads;
  if (!Array.isArray(days)) throw new Error('npm response has no downloads array');
  return days.reduce((sum: number, d: unknown) => {
    const n = (d as { downloads?: unknown })?.downloads;
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error('npm response has a non-numeric downloads entry');
    }
    return sum + n;
  }, 0);
}

/**
 * Read the scalar out of a Prometheus instant-query response. Returns null when
 * the query matched no series or the value is NaN (histogram with no
 * observations in the window): there is no latency figure to report. Throws on
 * an error response.
 */
export function parsePromScalar(body: unknown): number | null {
  const b = body as {
    status?: string;
    error?: string;
    data?: { result?: { value?: [number, string] }[] };
  };
  if (b?.status !== 'success') throw new Error(`prometheus error: ${b?.error ?? 'bad response'}`);
  const first = b.data?.result?.[0]?.value?.[1];
  if (first === undefined) return null;
  const v = Number(first);
  return Number.isFinite(v) ? v : null;
}

/** PromQL for a compute-latency quantile over a window ending at the query time. */
export function latencyQuantileQuery(q: number, windowSeconds: number, selector = ''): string {
  const matcher = selector ? `{${selector}}` : '';
  const range = Math.max(1, Math.round(windowSeconds));
  return (
    `histogram_quantile(${q}, sum by (le) ` +
    `(increase(bosphor_relayer_compute_latency_seconds_bucket${matcher}[${range}s])))`
  );
}

/** Format a byte count for humans (the JSON keeps the exact integer). */
export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${n} B` : `${v.toFixed(2)} ${units[i]}`;
}

const na = (m: { available: false; reason: string }) => `unavailable (${m.reason})`;

/** Render a report as a markdown evidence package. */
export function renderKpiMarkdown(r: KpiReport): string {
  const lines: string[] = [];
  lines.push(`# Bosphor KPI report`);
  lines.push('');
  lines.push(`Window: ${r.window.since} to ${r.window.until} (UTC, until exclusive)`);
  if (r.network) lines.push(`Network: ${r.network}`);
  lines.push('');

  lines.push('## Walrus storage ops (durable ledger)');
  lines.push('');
  if (!r.ledger.available) {
    lines.push(`Ledger: ${na(r.ledger)}`);
  } else {
    const k = r.ledger.value;
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Total ops | ${k.totalOps} |`);
    lines.push(`| Total bytes | ${k.totalBytes} (${formatBytes(k.totalBytes)}) |`);
    lines.push(`| Unique senders | ${k.uniqueSenders} |`);
    lines.push(`| Unique app ids | ${k.uniqueAppIds} |`);
    lines.push('');
    lines.push('### Ops by origin chain');
    lines.push('');
    lines.push(`| Chain | EID | Ops | Bytes |`);
    lines.push(`| --- | --- | --- | --- |`);
    for (const c of k.opsByChain) {
      lines.push(`| ${c.chain} | ${c.srcEid ?? 'n/a'} | ${c.ops} | ${c.bytes} |`);
    }
    lines.push('');
    lines.push('### Ops by app id');
    lines.push('');
    lines.push(`| App id | Ops | Bytes |`);
    lines.push(`| --- | --- | --- |`);
    for (const a of k.opsByApp) {
      lines.push(`| ${a.appId} | ${a.ops} | ${a.bytes} |`);
    }
  }
  lines.push('');

  lines.push('## Relayer compute latency (Prometheus)');
  lines.push('');
  if (!r.computeLatencySeconds.available) {
    lines.push(`Latency: ${na(r.computeLatencySeconds)}`);
  } else {
    const l = r.computeLatencySeconds.value;
    lines.push(`| Quantile | Seconds |`);
    lines.push(`| --- | --- |`);
    lines.push(`| p50 (median) | ${l.p50.toFixed(3)} |`);
    lines.push(`| p95 | ${l.p95.toFixed(3)} |`);
  }
  lines.push('');

  lines.push('## SDK adoption (npm)');
  lines.push('');
  if (!r.npmDownloads.available) {
    lines.push(`npm downloads: ${na(r.npmDownloads)}`);
  } else {
    lines.push(`${r.npmDownloads.value.package} downloads: ${r.npmDownloads.value.downloads}`);
  }
  lines.push('');
  return lines.join('\n');
}
