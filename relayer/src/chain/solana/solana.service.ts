import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey } from '@solana/web3.js';
import { SolanaIntentSubmitted, parseIntentSubmittedEvents } from './solana-intent.codec';

/** An `IntentSubmitted` event with the Solana transaction signature it came from. */
export interface SolanaSubmittedEvent extends SolanaIntentSubmitted {
  signature: string;
}

/** Result of one poll: the new events (oldest-first) and the newest cursor seen. */
export interface SolanaSubmitPoll {
  events: SolanaSubmittedEvent[];
  /** Newest signature observed this poll; the next poll pages only past it. */
  newestSignature?: string;
}

/** Max signatures fetched per poll (matches the DVN's paging window). */
const SIGNATURE_PAGE_LIMIT = 100;

/**
 * Reads the Bosphor Solana adapter's `IntentSubmitted` events off devnet.
 *
 * Enabled only when both SOLANA_RPC_URL and SOLANA_PROGRAM_ID are set, so the
 * EVM-only (mainnet) relayer runs unchanged. When enabled, it pages the adapter
 * program's confirmed transactions and decodes their Anchor event logs, mirroring
 * the proven self-DVN source. This service is read-only: it never signs or sends.
 */
@Injectable()
export class SolanaService implements OnModuleInit {
  private readonly logger = new Logger(SolanaService.name);
  private connection?: Connection;
  private program?: PublicKey;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const rpcUrl = this.config.get<string>('SOLANA_RPC_URL');
    const programId = this.config.get<string>('SOLANA_PROGRAM_ID');
    if (!rpcUrl || !programId) {
      this.logger.log('Solana origin watching disabled (SOLANA_RPC_URL / SOLANA_PROGRAM_ID unset)');
      return;
    }
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.program = new PublicKey(programId);
    this.logger.log(`Solana adapter: ${programId}`);
  }

  /** Whether Solana-origin support is configured on this deployment. */
  isEnabled(): boolean {
    return this.connection !== undefined && this.program !== undefined;
  }

  /**
   * Latest confirmed signature for the adapter program, or undefined if it has no
   * history yet. Used to seed the watcher cursor so it tracks intents from now
   * forward rather than replaying the program's whole history on startup.
   */
  async getLatestSignature(): Promise<string | undefined> {
    if (!this.connection || !this.program) return undefined;
    const sigs = await this.connection.getSignaturesForAddress(
      this.program,
      { limit: 1 },
      'confirmed',
    );
    return sigs[0]?.signature;
  }

  /**
   * Fetch `IntentSubmitted` events emitted since `untilSignature` (exclusive),
   * oldest-first, with the newest signature seen for cursor advance. A failed
   * (errored) transaction is skipped. Returns the prior cursor unchanged when
   * there is nothing new.
   */
  async pollIntentSubmitted(untilSignature?: string): Promise<SolanaSubmitPoll> {
    if (!this.connection || !this.program) return { events: [], newestSignature: untilSignature };

    const sigs = await this.connection.getSignaturesForAddress(
      this.program,
      { until: untilSignature, limit: SIGNATURE_PAGE_LIMIT },
      'confirmed',
    );
    if (sigs.length === 0) return { events: [], newestSignature: untilSignature };

    // getSignaturesForAddress returns newest-first; the newest is the next cursor.
    const newestSignature = sigs[0].signature;
    const events: SolanaSubmittedEvent[] = [];
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      const tx = await this.connection.getTransaction(s.signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      const logs = tx?.meta?.logMessages ?? [];
      for (const ev of parseIntentSubmittedEvents(logs)) {
        events.push({ ...ev, signature: s.signature });
      }
    }
    return { events, newestSignature };
  }
}
