import { PnlLedger } from './pnl-ledger';

describe('PnlLedger', () => {
  it('records a completed intent and computes net margin', () => {
    const led = new PnlLedger();
    const e = led.record({
      intentId: '0x1',
      status: 'completed',
      collectedUsd: 2.05,
      spentUsd: 1.42,
      netUsd: 0,
      timestampMs: 1,
    });
    expect(e.netUsd).toBeCloseTo(0.63, 6);
    expect(led.get('0x1')?.netUsd).toBeCloseTo(0.63, 6);
  });

  it('records a skipped intent as zero spend and zero collected', () => {
    const led = new PnlLedger();
    led.record({ intentId: '0x2', status: 'skipped', collectedUsd: 0, spentUsd: 0, netUsd: 0, timestampMs: 2 });
    const s = led.summary();
    expect(s.skipped).toBe(1);
    expect(s.totalSpentUsd).toBe(0);
  });

  it('is idempotent per intent id (no double count on retry)', () => {
    const led = new PnlLedger();
    led.record({ intentId: '0x3', status: 'completed', collectedUsd: 2, spentUsd: 1, netUsd: 0, timestampMs: 1 });
    led.record({ intentId: '0x3', status: 'completed', collectedUsd: 9, spentUsd: 9, netUsd: 0, timestampMs: 2 });
    expect(led.summary().count).toBe(1);
    expect(led.get('0x3')?.collectedUsd).toBe(2);
  });

  it('summarises the never-lose-money invariant (no negative completed intents)', () => {
    const led = new PnlLedger();
    led.record({ intentId: '0xa', status: 'completed', collectedUsd: 2.0, spentUsd: 1.4, netUsd: 0, timestampMs: 1 });
    led.record({ intentId: '0xb', status: 'completed', collectedUsd: 3.0, spentUsd: 2.5, netUsd: 0, timestampMs: 2 });
    led.record({ intentId: '0xc', status: 'skipped', collectedUsd: 0, spentUsd: 0, netUsd: 0, timestampMs: 3 });
    const s = led.summary();
    expect(s.completed).toBe(2);
    expect(s.negativeCount).toBe(0);
    expect(s.totalNetUsd).toBeCloseTo(1.1, 6);
  });

  it('flags a negative completed intent (invariant violation)', () => {
    const led = new PnlLedger();
    led.record({ intentId: '0xd', status: 'completed', collectedUsd: 1.0, spentUsd: 1.5, netUsd: 0, timestampMs: 1 });
    expect(led.summary().negativeCount).toBe(1);
  });
});
