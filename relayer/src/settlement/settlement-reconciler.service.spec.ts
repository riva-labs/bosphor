import { SettlementReconciler } from './settlement-reconciler.service';
import { MetricsService } from '../metrics/metrics.service';

describe('SettlementReconciler', () => {
  let metrics: jest.Mocked<Pick<MetricsService, 'recordIntentMargin' | 'recordWalSpendSkipped'>>;
  let reconciler: SettlementReconciler;
  let t: number;

  beforeEach(() => {
    metrics = {
      recordIntentMargin: jest.fn(),
      recordWalSpendSkipped: jest.fn(),
    };
    t = 1000;
    reconciler = new SettlementReconciler(metrics as unknown as MetricsService, () => t);
  });

  it('books a completed intent, computes net margin, and records the metric', () => {
    const e = reconciler.recordCompletion('0x1', { collectedUsd: 2.05, spentUsd: 1.42 });
    expect(e.netUsd).toBeCloseTo(0.63, 6);
    expect(metrics.recordIntentMargin).toHaveBeenCalledWith(e.netUsd);
    expect(reconciler.summary().completed).toBe(1);
    expect(reconciler.summary().negativeCount).toBe(0);
  });

  it('books a skipped intent as zero spend and records the skip metric', () => {
    const e = reconciler.recordSkip('0x2', 'escrow below cost + margin');
    expect(e.spentUsd).toBe(0);
    expect(e.netUsd).toBe(0);
    expect(metrics.recordWalSpendSkipped).toHaveBeenCalledTimes(1);
    expect(reconciler.summary().skipped).toBe(1);
  });

  it('every completed intent nets at least the margin (invariant)', () => {
    reconciler.recordCompletion('0xa', { collectedUsd: 2.0, spentUsd: 1.4 });
    reconciler.recordCompletion('0xb', { collectedUsd: 3.0, spentUsd: 2.5 });
    const s = reconciler.summary();
    expect(s.negativeCount).toBe(0);
    expect(s.totalNetUsd).toBeGreaterThan(0);
  });

  it('flags a negative completed intent as an invariant violation', () => {
    const e = reconciler.recordCompletion('0xbad', { collectedUsd: 1.0, spentUsd: 1.5 });
    expect(e.netUsd).toBeLessThan(0);
    expect(reconciler.summary().negativeCount).toBe(1);
  });

  it('is idempotent per intent id (retry does not double count)', () => {
    reconciler.recordCompletion('0x9', { collectedUsd: 2.0, spentUsd: 1.0 });
    reconciler.recordCompletion('0x9', { collectedUsd: 9.0, spentUsd: 9.0 });
    expect(reconciler.summary().count).toBe(1);
    expect(reconciler.get('0x9')?.collectedUsd).toBe(2.0);
  });
});
