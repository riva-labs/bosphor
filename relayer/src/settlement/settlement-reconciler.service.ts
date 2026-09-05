import { Injectable, Logger } from '@nestjs/common';
import { MetricsService } from '../metrics/metrics.service';
import { PnlEntry, PnlLedger, PnlSummary } from './pnl-ledger';

export interface CompletionAmounts {
  /** USD value of the escrow released to us on the proof. */
  collectedUsd: number;
  /** USD we actually spent fronting the store (WAL + Sui gas + return LZ). */
  spentUsd: number;
}

/**
 * Records the financial outcome of each intent and enforces the never-lose-money
 * invariant in observability. On a genuine proof-driven release it books the
 * reimbursement and the per-intent P&L; on a break-even skip it books a zero-spend
 * entry. Metrics expose the net margin and a negative-margin alert series that must
 * stay flat at zero. Idempotent per intent id via the underlying ledger.
 */
@Injectable()
export class SettlementReconciler {
  private readonly logger = new Logger(SettlementReconciler.name);
  private readonly ledger = new PnlLedger();

  constructor(
    private readonly metrics: MetricsService,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** Book a completed (proof-released) intent and its P&L. */
  recordCompletion(intentId: string, amounts: CompletionAmounts): PnlEntry {
    const entry = this.ledger.record({
      intentId,
      status: 'completed',
      collectedUsd: amounts.collectedUsd,
      spentUsd: amounts.spentUsd,
      netUsd: 0,
      timestampMs: this.clock(),
    });
    this.metrics.recordIntentMargin(entry.netUsd);
    if (entry.netUsd < 0) {
      // The break-even guard should make this impossible; if it ever fires, it is
      // a real invariant breach and must be loud (ties to the no-mock-data rule).
      this.logger.error(
        `NEVER-LOSE-MONEY INVARIANT VIOLATED for ${intentId}: collected ` +
          `$${amounts.collectedUsd.toFixed(4)} < spent $${amounts.spentUsd.toFixed(4)} ` +
          `(net $${entry.netUsd.toFixed(4)})`,
      );
    }
    return entry;
  }

  /** Book a skipped intent (break-even guard declined the spend): zero spend, zero loss. */
  recordSkip(intentId: string, reason: string): PnlEntry {
    const entry = this.ledger.record({
      intentId,
      status: 'skipped',
      collectedUsd: 0,
      spentUsd: 0,
      netUsd: 0,
      timestampMs: this.clock(),
    });
    this.metrics.recordWalSpendSkipped();
    this.logger.log(`Intent ${intentId} skipped (no spend): ${reason}`);
    return entry;
  }

  get(intentId: string): PnlEntry | undefined {
    return this.ledger.get(intentId);
  }

  summary(): PnlSummary {
    return this.ledger.summary();
  }
}
