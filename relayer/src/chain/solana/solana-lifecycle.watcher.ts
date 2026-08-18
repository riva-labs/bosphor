import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { SolanaService } from './solana.service';
import { SuiService } from '../sui/sui.service';
import { IntentLifecycleStore } from '../../lifecycle/intent-lifecycle.store';
import { HopDetails, IntentHop } from '../../lifecycle/intent-lifecycle.types';
import { POLL_INTERVAL_MS } from '../../common/constants';

/**
 * Records the `submitted` hop for Solana-origin intents.
 *
 * A Solana-origin intent has no EVM `IntentSubmitted` log, so without this
 * watcher the relayer never learns the commitment: ingest rejects the
 * out-of-band bytes ("no pending intent") and the processor cannot run
 * `execute_store`. This watcher reads the adapter's own `IntentSubmitted` event
 * and records the commitment (blob id, size, deadline) early, exactly like the
 * EVM lifecycle watcher, so the ingest-before-delivery path works uniformly.
 *
 * The recorded `sender` is the Sui address that will receive the stored blob.
 * The intent's true origin is a Solana pubkey, which cannot own a Sui object, so
 * for the M3 single-relayer model the recipient is a configured Sui address
 * (SOLANA_SUI_RECIPIENT), defaulting to the relayer's own Sui address. This is
 * the single point where the single-relayer assumption lives; a permissionless
 * design would map the origin to a real recipient here.
 *
 * Like the EVM watcher, this observes Solana only and never drives fulfillment
 * (that stays on the Sui LZ delivery path). It is inert unless Solana support is
 * configured, so the EVM-only relayer is unaffected.
 */
@Injectable()
export class SolanaLifecycleWatcher implements OnModuleInit {
  private readonly logger = new Logger(SolanaLifecycleWatcher.name);
  private cursor?: string;
  private polling = false;
  private recipient?: string;

  constructor(
    private readonly solana: SolanaService,
    private readonly sui: SuiService,
    private readonly lifecycle: IntentLifecycleStore,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.solana.isEnabled()) return;

    // The blob recipient on Sui for Solana-origin intents. A Solana pubkey cannot
    // own a Sui object, so the M3 single-relayer model routes the blob to a
    // configured Sui address, defaulting to the relayer's own address.
    this.recipient = this.config.get<string>('SOLANA_SUI_RECIPIENT') || this.sui.getAddress();

    // Start from the current head so the feed tracks intents from now forward.
    this.cursor = await this.solana.getLatestSignature();
    this.logger.log(
      `Watching Solana-origin intents (recipient ${this.recipient}, cursor ${this.cursor ?? 'none'})`,
    );
  }

  @Interval(POLL_INTERVAL_MS)
  scheduledPoll(): void {
    if (!this.solana.isEnabled() || this.polling) return;
    this.polling = true;
    void this.pollOnce()
      .catch((err) => this.logger.warn(`Solana poll failed: ${err}`))
      .finally(() => {
        this.polling = false;
      });
  }

  async pollOnce(): Promise<void> {
    const { events, newestSignature } = await this.solana.pollIntentSubmitted(this.cursor);

    for (const e of events) {
      // Record the commitment alongside the submitted hop so ingest can bind the
      // out-of-band bytes and the processor can resolve the blob recipient. The
      // on-chain deadline is epoch seconds; the ingest path compares against
      // Date.now() in ms, so convert once here at the boundary.
      await this.trackHop(e.intentId, 'submitted', {
        sender: this.recipient,
        txHash: e.signature,
        committedBlobId: e.committedBlobId,
        size: e.size,
        deadline: Number(e.deadline) * 1000,
      });
      this.logger.log(`[${e.intentId}] Solana intent submitted (sig ${e.signature})`);
    }

    this.cursor = newestSignature;
  }

  private async trackHop(intentId: string, hop: IntentHop, details?: HopDetails): Promise<void> {
    try {
      await this.lifecycle.recordHop(intentId, hop, details);
    } catch (err) {
      this.logger.warn(`[${intentId}] Failed to record ${hop} hop: ${err}`);
    }
  }
}
