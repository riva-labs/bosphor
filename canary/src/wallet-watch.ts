import type { CanaryMetrics } from './metrics.ts';
import type { ChainAdapter } from './wallet-chains.ts';
import { isNativeCoin, type WalletChain, type WatchedWallet } from './wallet-config.ts';
import { decideTopUp, TopUpLedger } from './topup.ts';

export interface WalletWatcherOptions {
  wallets: WatchedWallet[];
  adapters: Partial<Record<WalletChain, ChainAdapter>>;
  metrics: Pick<CanaryMetrics, 'setWalletBalance' | 'recordWalletReadError' | 'recordTopUp'>;
  /** TOPUP_ENABLED=true. Still a no-op off test networks. */
  topUpEnabled: boolean;
  log?: (msg: string) => void;
  now?: () => number;
}

function walletKey(w: WatchedWallet): string {
  return `${w.chain}:${w.address.toLowerCase()}:${w.coin}`;
}

/**
 * One exporter for every service wallet on every chain, plus the testnet-only
 * auto top-up. Each `tick()` reads all balances, publishes the gauges, then
 * refills any wallet below its floor from that chain's treasury.
 *
 * A failed read never sets a value: the gauge stays at its last real reading
 * and the read-error counter goes up, so alerts see the failure instead of a
 * made-up number. A wallet whose read failed this tick is never topped up.
 */
export class WalletWatcher {
  private readonly ledger = new TopUpLedger();
  private readonly networks = new Map<WalletChain, Promise<string>>();
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly o: WalletWatcherOptions) {
    this.log = o.log ?? ((m) => console.log(`[wallets] ${m}`));
    this.now = o.now ?? Date.now;
  }

  async tick(): Promise<void> {
    const balances = new Map<string, number>();
    await Promise.all(
      this.o.wallets.map(async (w) => {
        const adapter = this.o.adapters[w.chain];
        try {
          if (!adapter) throw new Error(`no ${w.chain} adapter configured`);
          const amount = await adapter.readBalance(w);
          if (!Number.isFinite(amount)) throw new Error(`non-numeric balance ${amount}`);
          balances.set(walletKey(w), amount);
          this.o.metrics.setWalletBalance(
            { chain: w.chain, network: w.network, role: w.role, address: w.address, coin: w.coin },
            amount,
          );
        } catch (err) {
          this.o.metrics.recordWalletReadError(w.chain, w.role);
          this.log(`balance read failed for ${w.role} ${w.chain} ${w.coin} ${w.address}: ${err}`);
        }
      }),
    );

    // Top-ups run per chain, sequentially within a chain so one treasury never
    // races itself (nonce / gas-object conflicts).
    const chains = [...new Set(this.o.wallets.map((w) => w.chain))];
    await Promise.all(chains.map((c) => this.topUpChain(c, balances)));
  }

  /** Detected network for a chain, cached on success (a failed lookup retries next tick). */
  private detectNetwork(adapter: ChainAdapter): Promise<string> {
    let p = this.networks.get(adapter.chain);
    if (!p) {
      p = adapter.detectNetwork();
      this.networks.set(adapter.chain, p);
      p.catch(() => this.networks.delete(adapter.chain));
    }
    return p;
  }

  private async topUpChain(chain: WalletChain, balances: Map<string, number>): Promise<void> {
    const adapter = this.o.adapters[chain];
    const treasury = adapter?.treasury;
    const candidates = this.o.wallets.filter(
      (w) =>
        w.chain === chain &&
        w.floor !== undefined &&
        isNativeCoin(w) &&
        balances.has(walletKey(w)) &&
        balances.get(walletKey(w))! < w.floor &&
        w.address.toLowerCase() !== treasury?.address.toLowerCase(),
    );
    if (!adapter || candidates.length === 0) return;
    if (!treasury) {
      for (const w of candidates) this.log(`${w.role} ${chain} below floor, no treasury key: alert only`);
      return;
    }

    let treasuryNetwork: string;
    let treasuryBalance: number;
    try {
      treasuryNetwork = await this.detectNetwork(adapter);
      treasuryBalance = await adapter.readBalance({ address: treasury.address, decimals: candidates[0].decimals });
    } catch (err) {
      for (const w of candidates) this.o.metrics.recordTopUp(chain, w.role, 'error');
      this.log(`${chain} treasury read failed, skipping top-ups: ${err}`);
      return;
    }

    for (const w of candidates) {
      const balance = balances.get(walletKey(w))!;
      const key = walletKey(w);
      const decision = decideTopUp({
        network: w.network,
        treasuryNetwork,
        enabled: this.o.topUpEnabled,
        balance,
        floor: w.floor,
        target: w.target,
        dailyCap: w.dailyCap,
        sentLast24h: this.ledger.sentInWindow(key, this.now()),
        treasuryBalance,
        treasuryFloor: treasury.floor,
      });

      if (decision.action === 'none') {
        if (decision.reason === 'not_test_network') {
          this.log(
            `${w.role} ${chain} (${w.network}, rpc ${treasuryNetwork}) below floor: not a test network, top-up is a no-op`,
          );
        } else if (decision.reason === 'disabled') {
          this.log(`${w.role} ${chain} below floor: TOPUP_ENABLED is not true, alert only`);
        } else if (decision.reason === 'daily_cap' || decision.reason === 'treasury_floor') {
          this.o.metrics.recordTopUp(chain, w.role, decision.reason);
          this.log(`${w.role} ${chain} below floor (${balance}) but blocked by ${decision.reason}`);
        }
        continue;
      }

      // Count the attempt against the cap before sending: if the send errors
      // after broadcasting, a retry next tick must not double the refill.
      this.ledger.record(key, decision.amount, this.now());
      try {
        const txId = await treasury.send(w.address, decision.amount);
        treasuryBalance -= decision.amount;
        this.o.metrics.recordTopUp(chain, w.role, 'success');
        this.log(`topped up ${w.role} ${chain} ${w.address} with ${decision.amount} ${w.coin}: ${txId}`);
      } catch (err) {
        this.o.metrics.recordTopUp(chain, w.role, 'error');
        this.log(`top-up of ${w.role} ${chain} ${w.address} failed: ${err}`);
      }
    }
  }
}
