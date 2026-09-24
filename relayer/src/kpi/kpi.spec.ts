import { StorageOpEntry } from '../ledger/storage-op-ledger.types';
import {
  KpiReport,
  aggregateLedger,
  available,
  eidName,
  formatBytes,
  latencyQuantileQuery,
  parsePromScalar,
  renderKpiMarkdown,
  sumNpmDownloads,
  unavailable,
} from './kpi';

function e(o: Partial<StorageOpEntry>): StorageOpEntry {
  return {
    intentId: '0x1',
    srcEid: 40161,
    sender: '0xAbC',
    size: 100,
    blobId: null,
    walrusBlobId: null,
    walrusObjectId: null,
    endEpoch: null,
    appId: null,
    network: 'testnet',
    storeDigest: null,
    createdAt: 0,
    storedAt: 0,
    ...o,
  };
}

describe('eidName', () => {
  it.each([
    [40161, 'sepolia'],
    [40168, 'solana-devnet'],
    [30101, 'ethereum'],
    [30168, 'solana'],
    [30184, 'base'],
    [30110, 'arbitrum'],
  ])('maps %i to %s', (eid, name) => expect(eidName(eid)).toBe(name));

  it('labels unmapped and missing EIDs without guessing', () => {
    expect(eidName(12345)).toBe('eid-12345');
    expect(eidName(null)).toBe('unknown');
  });
});

describe('aggregateLedger', () => {
  const entries = [
    e({ intentId: '1', srcEid: 40161, sender: '0xAbC', size: 100, appId: 'drive' }),
    e({ intentId: '2', srcEid: 40161, sender: '0xabc', size: 50, appId: 'drive' }),
    e({ intentId: '3', srcEid: 40168, sender: 'SoLKey', size: 25, appId: null }),
    e({ intentId: '4', srcEid: 40168, sender: 'solkey', size: 5, appId: 'canary' }),
    e({ intentId: '5', srcEid: 30184, sender: null, size: null, appId: null }),
  ];

  it('counts totals, bytes, unique senders and unique app ids', () => {
    const k = aggregateLedger(entries);
    expect(k.totalOps).toBe(5);
    expect(k.totalBytes).toBe(180);
    // EVM hex senders are case-insensitive; Solana base58 is case-sensitive.
    expect(k.uniqueSenders).toBe(3);
    // 'none' (no X-Bosphor-App) is not counted as an app.
    expect(k.uniqueAppIds).toBe(2);
  });

  it('groups ops and bytes by origin chain, busiest first', () => {
    const k = aggregateLedger(entries);
    expect(k.opsByChain).toEqual([
      { srcEid: 40161, chain: 'sepolia', ops: 2, bytes: 150 },
      { srcEid: 40168, chain: 'solana-devnet', ops: 2, bytes: 30 },
      { srcEid: 30184, chain: 'base', ops: 1, bytes: 0 },
    ]);
  });

  it('groups ops by app id with `none` for ops sent without one', () => {
    const k = aggregateLedger(entries);
    expect(k.opsByApp).toEqual([
      { appId: 'drive', ops: 2, bytes: 150 },
      { appId: 'none', ops: 2, bytes: 25 },
      { appId: 'canary', ops: 1, bytes: 5 },
    ]);
  });

  it('reports real zeros for an empty window', () => {
    expect(aggregateLedger([])).toEqual({
      totalOps: 0,
      totalBytes: 0,
      uniqueSenders: 0,
      uniqueAppIds: 0,
      opsByChain: [],
      opsByApp: [],
    });
  });
});

describe('sumNpmDownloads', () => {
  it('sums the daily downloads', () => {
    expect(
      sumNpmDownloads({
        package: '@bosphor/sdk',
        downloads: [
          { day: '2026-09-01', downloads: 3 },
          { day: '2026-09-02', downloads: 4 },
        ],
      }),
    ).toBe(7);
  });

  it('throws on an unexpected shape instead of returning a number', () => {
    expect(() => sumNpmDownloads({ error: 'package @bosphor/sdk not found' })).toThrow();
    expect(() => sumNpmDownloads({ downloads: [{ day: 'x', downloads: 'lots' }] })).toThrow();
  });
});

describe('parsePromScalar', () => {
  it('reads the first sample value', () => {
    expect(parsePromScalar({ status: 'success', data: { result: [{ value: [1, '0.42'] }] } })).toBe(
      0.42,
    );
  });

  it('returns null when there is no data (no series or NaN)', () => {
    expect(parsePromScalar({ status: 'success', data: { result: [] } })).toBeNull();
    expect(
      parsePromScalar({ status: 'success', data: { result: [{ value: [1, 'NaN'] }] } }),
    ).toBeNull();
  });

  it('throws on an error response', () => {
    expect(() => parsePromScalar({ status: 'error', error: 'bad query' })).toThrow('bad query');
  });
});

describe('latencyQuantileQuery', () => {
  it('builds a histogram_quantile over the window, with an optional selector', () => {
    expect(latencyQuantileQuery(0.5, 3600)).toBe(
      'histogram_quantile(0.5, sum by (le) (increase(bosphor_relayer_compute_latency_seconds_bucket[3600s])))',
    );
    expect(latencyQuantileQuery(0.95, 60, 'deployment="testnet"')).toContain(
      'bucket{deployment="testnet"}[60s]',
    );
  });
});

describe('renderKpiMarkdown', () => {
  it('prints "unavailable" for sources that could not be read', () => {
    const r: KpiReport = {
      window: { since: '2026-09-01T00:00:00.000Z', until: '2026-09-02T00:00:00.000Z' },
      network: null,
      ledger: unavailable('DATABASE_URL not set'),
      computeLatencySeconds: unavailable('PROMETHEUS_URL not set'),
      npmDownloads: unavailable('npm API returned 503'),
    };
    const md = renderKpiMarkdown(r);
    expect(md).toContain('Ledger: unavailable (DATABASE_URL not set)');
    expect(md).toContain('Latency: unavailable (PROMETHEUS_URL not set)');
    expect(md).toContain('npm downloads: unavailable (npm API returned 503)');
  });

  it('prints the ledger tables and latency when available', () => {
    const r: KpiReport = {
      window: { since: 'a', until: 'b' },
      network: 'testnet',
      ledger: available(aggregateLedger([e({ appId: 'drive', size: 2048 })])),
      computeLatencySeconds: available({ p50: 0.1234, p95: 0.9 }),
      npmDownloads: available({ package: '@bosphor/sdk', downloads: 12 }),
    };
    const md = renderKpiMarkdown(r);
    expect(md).toContain('| Total ops | 1 |');
    expect(md).toContain('| Total bytes | 2048 (2.00 KiB) |');
    expect(md).toContain('| sepolia | 40161 | 1 | 2048 |');
    expect(md).toContain('| drive | 1 | 2048 |');
    expect(md).toContain('| p50 (median) | 0.123 |');
    expect(md).toContain('@bosphor/sdk downloads: 12');
  });
});

describe('formatBytes', () => {
  it('keeps small values exact and scales large ones', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.00 MiB');
  });
});
