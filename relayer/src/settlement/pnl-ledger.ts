/** Outcome of an intent from the never-lose-money accounting's point of view. */
export type PnlStatus = 'completed' | 'skipped';

/** One per-intent profit-and-loss record. */
export interface PnlEntry {
  intentId: string;
  status: PnlStatus;
  /** USD value of the escrow released to us (0 for a skipped intent). */
  collectedUsd: number;
  /** USD we actually spent fronting the store (0 for a skipped intent). */
  spentUsd: number;
  /** collectedUsd - spentUsd. */
  netUsd: number;
  /** When the entry was recorded (epoch ms), stamped by the caller. */
  timestampMs: number;
}

export interface PnlSummary {
  count: number;
  completed: number;
  skipped: number;
  totalCollectedUsd: number;
  totalSpentUsd: number;
  totalNetUsd: number;
  /** Completed intents that netted below zero. The invariant requires this to be 0. */
  negativeCount: number;
}

/**
 * In-memory per-intent P&L ledger. Deterministic and side-effect-free (the
 * caller supplies timestamps), so the never-lose-money invariant can be asserted
 * directly in tests: every completed intent nets >= its margin, every skipped one
 * spends nothing. Idempotent per intent id: recording the same id twice keeps the
 * first entry, matching the pipeline's per-step idempotency (no double count).
 */
export class PnlLedger {
  private readonly entries = new Map<string, PnlEntry>();

  /** Record (idempotently) an intent's outcome. Returns the stored entry. */
  record(entry: PnlEntry): PnlEntry {
    if (!Number.isFinite(entry.collectedUsd) || !Number.isFinite(entry.spentUsd)) {
      throw new Error(`PnlLedger: non-finite amounts for ${entry.intentId}`);
    }
    const existing = this.entries.get(entry.intentId);
    if (existing) return existing;
    const stored: PnlEntry = { ...entry, netUsd: entry.collectedUsd - entry.spentUsd };
    this.entries.set(entry.intentId, stored);
    return stored;
  }

  get(intentId: string): PnlEntry | undefined {
    return this.entries.get(intentId);
  }

  all(): PnlEntry[] {
    return [...this.entries.values()];
  }

  summary(): PnlSummary {
    let completed = 0;
    let skipped = 0;
    let totalCollectedUsd = 0;
    let totalSpentUsd = 0;
    let negativeCount = 0;
    for (const e of this.entries.values()) {
      if (e.status === 'completed') completed++;
      else skipped++;
      totalCollectedUsd += e.collectedUsd;
      totalSpentUsd += e.spentUsd;
      if (e.status === 'completed' && e.netUsd < 0) negativeCount++;
    }
    return {
      count: this.entries.size,
      completed,
      skipped,
      totalCollectedUsd,
      totalSpentUsd,
      totalNetUsd: totalCollectedUsd - totalSpentUsd,
      negativeCount,
    };
  }
}
