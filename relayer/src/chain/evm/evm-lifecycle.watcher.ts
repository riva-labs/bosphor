import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { EvmService } from './evm.service';
import { IntentLifecycleStore } from '../../lifecycle/intent-lifecycle.store';
import { HopDetails, IntentHop } from '../../lifecycle/intent-lifecycle.types';
import { POLL_INTERVAL_MS } from '../../common/constants';

/**
 * Records the two EVM-side bookend hops of the intent lifecycle for the public
 * feed: `submitted` (from IntentSubmitted) and `confirmed` (from IntentExecuted,
 * the return proof landing back on EVM). The relayer is the single writer to the
 * store; this watcher observes EVM only and never drives fulfillment (that stays
 * on the Sui LZ path).
 */
@Injectable()
export class EvmLifecycleWatcher implements OnModuleInit {
  private readonly logger = new Logger(EvmLifecycleWatcher.name);
  private cursor = 0;
  private polling = false;

  constructor(
    private readonly evm: EvmService,
    private readonly lifecycle: IntentLifecycleStore,
  ) {}

  async onModuleInit(): Promise<void> {
    // Start from the current head; the feed tracks intents from now forward.
    this.cursor = await this.evm.getBlockNumber();
    this.logger.log(`Watching EVM lifecycle events from block ${this.cursor}`);
  }

  @Interval(POLL_INTERVAL_MS)
  scheduledPoll(): void {
    if (this.polling) return;
    this.polling = true;
    void this.pollOnce().finally(() => {
      this.polling = false;
    });
  }

  async pollOnce(): Promise<void> {
    const { submitted, executed, newFromBlock } = await this.evm.pollLifecycleEvents(this.cursor);

    for (const e of submitted) {
      await this.trackHop(e.intentId, 'submitted', { sender: e.sender, txHash: e.txHash });
    }
    for (const e of executed) {
      await this.trackHop(e.intentId, 'confirmed', { txHash: e.txHash });
    }

    this.cursor = newFromBlock;
  }

  private async trackHop(intentId: string, hop: IntentHop, details?: HopDetails): Promise<void> {
    try {
      await this.lifecycle.recordHop(intentId, hop, details);
    } catch (err) {
      this.logger.warn(`[${intentId}] Failed to record ${hop} hop: ${err}`);
    }
  }
}
