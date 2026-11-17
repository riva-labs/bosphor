/**
 * Testnet auto top-up decision logic. Pure: no I/O, so every branch is unit
 * tested. The watcher feeds it the latest balances and sends whatever it
 * returns.
 *
 * Funds only ever move on a test network with an explicit opt-in. On mainnet
 * this always says "none": mainnet wallets are alerted on, never refilled.
 */

/** Network labels on which a top-up is allowed to move funds. */
export const TEST_NETWORKS: ReadonlySet<string> = new Set(['testnet', 'devnet', 'sepolia']);

export function isTestNetwork(network: string): boolean {
  return TEST_NETWORKS.has(network.toLowerCase());
}

export interface TopUpInput {
  /** Network label of the watched wallet. */
  network: string;
  /** Network the treasury's RPC actually reports (detected, not configured). */
  treasuryNetwork: string;
  /** TOPUP_ENABLED=true. */
  enabled: boolean;
  /** Watched wallet balance, whole tokens. */
  balance: number;
  floor?: number;
  target?: number;
  /** Max amount sent to this wallet per rolling 24h, whole tokens. */
  dailyCap?: number;
  /** Already sent to this wallet in the current rolling 24h window. */
  sentLast24h: number;
  /** Treasury balance, whole tokens. */
  treasuryBalance: number;
  /** The treasury must never be drawn below this, whole tokens. */
  treasuryFloor: number;
}

export type TopUpSkipReason =
  | 'not_test_network'
  | 'disabled'
  | 'not_configured'
  | 'above_floor'
  | 'daily_cap'
  | 'treasury_floor';

export type TopUpDecision =
  | { action: 'send'; amount: number }
  | { action: 'none'; reason: TopUpSkipReason };

/** Amounts below this (whole tokens) are dust and not worth a transaction. */
const MIN_SEND = 1e-6;

export function decideTopUp(i: TopUpInput): TopUpDecision {
  // Hard guard first: both the configured label and the RPC-detected network
  // must be a test network, so a mislabelled mainnet wallet cannot be refilled.
  if (!isTestNetwork(i.network) || !isTestNetwork(i.treasuryNetwork)) {
    return { action: 'none', reason: 'not_test_network' };
  }
  if (!i.enabled) return { action: 'none', reason: 'disabled' };
  if (i.floor === undefined || i.target === undefined || i.dailyCap === undefined) {
    return { action: 'none', reason: 'not_configured' };
  }
  if (!(i.balance < i.floor)) return { action: 'none', reason: 'above_floor' };

  const want = i.target - i.balance;
  const capLeft = i.dailyCap - i.sentLast24h;
  if (capLeft < MIN_SEND) return { action: 'none', reason: 'daily_cap' };

  const treasuryLeft = i.treasuryBalance - i.treasuryFloor;
  const amount = Math.min(want, capLeft, treasuryLeft);
  if (treasuryLeft < MIN_SEND || amount < MIN_SEND) {
    return { action: 'none', reason: 'treasury_floor' };
  }
  return { action: 'send', amount };
}

/**
 * Rolling 24h record of what was sent to each wallet, for the daily cap.
 * In memory: a canary restart resets it, which at worst allows one extra
 * day's cap. The treasury floor still bounds the total.
 */
export class TopUpLedger {
  private readonly sends = new Map<string, { at: number; amount: number }[]>();

  constructor(private readonly windowMs = 24 * 60 * 60 * 1000) {}

  record(key: string, amount: number, nowMs: number): void {
    const list = this.sends.get(key) ?? [];
    list.push({ at: nowMs, amount });
    this.sends.set(key, list);
  }

  sentInWindow(key: string, nowMs: number): number {
    const list = (this.sends.get(key) ?? []).filter((s) => nowMs - s.at < this.windowMs);
    this.sends.set(key, list);
    return list.reduce((sum, s) => sum + s.amount, 0);
  }
}
