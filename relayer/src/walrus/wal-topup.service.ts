import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { Transaction } from '@mysten/sui/transactions';
import { SuiService } from '../chain/sui/sui.service';
import { MetricsService } from '../metrics/metrics.service';
import {
  WAL_COIN_TYPE,
  SUI_COIN_TYPE,
  WAL_EXCHANGE_PACKAGE,
  WAL_EXCHANGE_OBJECTS,
  MIST_PER_UNIT,
  WAL_CHECK_INTERVAL_MS,
} from '../common/constants';

/**
 * Keeps the relayer's WAL funded so Walrus storage payments never block
 * fulfillment. WAL is consumed on every store and there is no faucet in the
 * fulfillment path, so on testnet the relayer refills itself: when WAL drops
 * below a floor, it swaps a fixed amount of SUI for WAL on the Walrus testnet
 * exchange (the same exchange `walrus get-wal` uses). As long as the relayer
 * holds SUI, it self-heals.
 *
 * This was added after a live drain: the relayer's WAL hit ~0 and every
 * `execute_store` failed with an insufficient-WAL abort while its SUI balance
 * was healthy. Swapping SUI it already holds removes the manual-refill step.
 */
@Injectable()
export class WalTopUpService implements OnModuleInit {
  private readonly logger = new Logger(WalTopUpService.name);
  private minBalanceMist!: bigint;
  private topUpSuiMist!: bigint;
  private suiReserveMist!: bigint;
  // Serialize top-ups so N concurrent intents never launch two swaps at once.
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly sui: SuiService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit() {
    this.minBalanceMist = BigInt(this.config.get<number>('WAL_MIN_BALANCE_MIST', 500_000_000));
    this.topUpSuiMist = BigInt(this.config.get<number>('WAL_TOPUP_SUI_MIST', 1_000_000_000));
    this.suiReserveMist = BigInt(
      this.config.get<number>('WAL_TOPUP_SUI_RESERVE_MIST', 1_000_000_000),
    );
    this.logger.log(
      `WAL auto top-up: floor ${this.fmt(this.minBalanceMist)} WAL, ` +
        `swap ${this.fmt(this.topUpSuiMist)} SUI, keep ${this.fmt(this.suiReserveMist)} SUI reserve`,
    );
  }

  /**
   * Background safety net: refresh the balance gauges and top up if low even
   * when no intents are flowing, so an idle relayer never silently drains.
   */
  @Interval(WAL_CHECK_INTERVAL_MS)
  periodicCheck(): void {
    void this.ensureWal();
  }

  /**
   * Ensure the relayer holds enough WAL to pay for storage. Reads and publishes
   * the WAL balance, and if it is below the floor, swaps SUI for WAL. Serialized
   * so concurrent callers trigger at most one swap. Never throws: a swap hiccup
   * must not mask the caller's own loud failure if WAL is still short.
   */
  async ensureWal(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    let walBalance: bigint;
    try {
      walBalance = await this.getBalance(WAL_COIN_TYPE);
    } catch (err) {
      this.logger.warn(`Could not read WAL balance, skipping top-up check: ${err}`);
      return;
    }
    this.metrics.setWalBalance(this.toUnits(walBalance));

    if (walBalance >= this.minBalanceMist) return;

    let suiBalance: bigint;
    try {
      suiBalance = await this.getBalance(SUI_COIN_TYPE);
    } catch (err) {
      this.logger.error(`WAL low (${this.fmt(walBalance)}) but SUI balance read failed: ${err}`);
      return;
    }
    this.metrics.setSuiBalance(this.toUnits(suiBalance));

    // Never spend the gas reserve on a swap: if we cannot swap without eating
    // into it, this is not self-healable. Fail loudly so the alert pages.
    if (suiBalance < this.topUpSuiMist + this.suiReserveMist) {
      this.metrics.recordWalTopUp('insufficient_sui');
      this.logger.error(
        `WAL low (${this.fmt(walBalance)} < ${this.fmt(this.minBalanceMist)} WAL) but SUI too ` +
          `low to swap (${this.fmt(suiBalance)} SUI, need ` +
          `${this.fmt(this.topUpSuiMist + this.suiReserveMist)}). Fund the relayer's SUI.`,
      );
      return;
    }

    this.logger.log(
      `WAL low (${this.fmt(walBalance)} WAL), swapping ${this.fmt(this.topUpSuiMist)} SUI for WAL...`,
    );
    try {
      const digest = await this.swapSuiForWal(this.topUpSuiMist);
      await this.sui.getClient().core.waitForTransaction({ digest });
      const newBalance = await this.getBalance(WAL_COIN_TYPE);
      this.metrics.setWalBalance(this.toUnits(newBalance));
      this.metrics.recordWalTopUp('success');
      this.logger.log(`WAL top-up complete: ${this.fmt(newBalance)} WAL (tx ${digest})`);
    } catch (err) {
      this.metrics.recordWalTopUp('failure');
      this.logger.error(`WAL top-up swap failed: ${err}`);
    }
  }

  async getBalance(coinType: string): Promise<bigint> {
    const res = await this.sui.getClient().core.getBalance({
      owner: this.sui.getAddress(),
      coinType,
    });
    return BigInt(res.balance.balance);
  }

  /** Build + execute a PTB that swaps `suiMist` SUI for WAL and keeps the WAL. */
  private async swapSuiForWal(suiMist: bigint): Promise<string> {
    const tx = new Transaction();
    const [suiCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(suiMist)]);
    const walCoin = tx.moveCall({
      target: `${WAL_EXCHANGE_PACKAGE}::wal_exchange::exchange_all_for_wal`,
      arguments: [tx.object(WAL_EXCHANGE_OBJECTS[0]), suiCoin],
    });
    tx.transferObjects([walCoin], tx.pure.address(this.sui.getAddress()));
    const { digest, status } = await this.sui.signAndExecute(tx);
    if (!status.success) {
      throw new Error(`WAL exchange tx failed: ${JSON.stringify(status)}`);
    }
    return digest;
  }

  private toUnits(mist: bigint): number {
    return Number(mist) / Number(MIST_PER_UNIT);
  }

  private fmt(mist: bigint): string {
    return this.toUnits(mist).toFixed(4);
  }
}
