import { readFileSync } from 'fs';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getBytes } from 'ethers';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  SolanaIntentSubmitted,
  encodeConfirmExecutionData,
  parseIntentSubmittedEvents,
} from './solana-intent.codec';

/** PDA seed for the singleton Store (OApp) account: `[b"store"]`. */
const STORE_SEED = Buffer.from('store');
/** PDA seed prefix for a per-intent IntentState account: `[b"intent", intentId]`. */
const INTENT_SEED = Buffer.from('intent');

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

/** Compact an error to a short single-line message for logs. */
function short(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 100);
}

/**
 * Load a Solana keypair from either an inline JSON secret-key array (the standard
 * `solana-keygen` file format, `[n,n,...]`) or a path to such a file. Accepting a
 * path keeps the 64-byte secret out of the process environment when preferred.
 */
function loadKeypair(value: string): Keypair {
  const raw = value.trim().startsWith('[') ? value : readFileSync(value.trim(), 'utf-8');
  const secret = Uint8Array.from(JSON.parse(raw) as number[]);
  return Keypair.fromSecretKey(secret);
}

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
  /** Store-admin keypair used to sign the return-leg confirm_execution. */
  private admin?: Keypair;

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

    // Optional store-admin signer for the return leg. Without it the relayer can
    // still ingest and run execute_store; it just cannot close the round trip on
    // Solana (confirm_execution), which is logged loudly rather than skipped.
    const keypair = this.config.get<string>('SOLANA_RELAYER_KEYPAIR');
    if (keypair) {
      this.admin = loadKeypair(keypair);
      this.logger.log(`Solana return signer: ${this.admin.publicKey.toBase58()}`);
    } else {
      this.logger.warn('SOLANA_RELAYER_KEYPAIR unset - Solana return leg (confirm_execution) disabled');
    }
  }

  /** Whether Solana-origin support is configured on this deployment. */
  isEnabled(): boolean {
    return this.connection !== undefined && this.program !== undefined;
  }

  /** Whether the relayer can sign the Solana return leg (confirm_execution). */
  canConfirm(): boolean {
    return this.isEnabled() && this.admin !== undefined;
  }

  /**
   * Close the round trip on Solana: record the execution result on the origin
   * IntentState via the owner-gated `confirm_execution` (the Solana mirror of the
   * EVM `confirmExecution` fallback). Asserts on-chain that `returnedBlobId` equals
   * the commitment, so the reference guarantee holds. Returns the tx signature.
   *
   * `returnedBlobId` is the canonical big-endian 0x-hex blob id (the same bytes the
   * EVM proof carries), matching the commitment recorded at submit.
   *
   * Idempotent: on the rate-limited devnet a confirm can land on-chain while the
   * client times out (or is retried). If the send fails but the IntentState is
   * already executed, that is treated as success (the sentinel `ALREADY_EXECUTED`),
   * mirroring how the Sui path treats `EIntentAlreadyExecuted`. `confirm_execution`
   * itself asserts `!executed`, so a genuine re-send would abort `AlreadyExecuted`;
   * this turns that into a success instead of a stuck intent.
   */
  async confirmExecution(
    intentId: string,
    returnedBlobId: string,
    endEpoch: bigint,
  ): Promise<string> {
    if (!this.connection || !this.program || !this.admin) {
      throw new Error('Solana return leg not configured (SOLANA_RELAYER_KEYPAIR unset)');
    }

    const [storePda] = PublicKey.findProgramAddressSync([STORE_SEED], this.program);
    const [intentPda] = PublicKey.findProgramAddressSync(
      [INTENT_SEED, Buffer.from(getBytes(intentId))],
      this.program,
    );

    const ix = new TransactionInstruction({
      programId: this.program,
      keys: [
        { pubkey: this.admin.publicKey, isSigner: true, isWritable: true },
        { pubkey: storePda, isSigner: false, isWritable: false },
        { pubkey: intentPda, isSigner: false, isWritable: true },
      ],
      data: encodeConfirmExecutionData(intentId, returnedBlobId, endEpoch),
    });

    try {
      return await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(ix),
        [this.admin],
        { commitment: 'confirmed' },
      );
    } catch (err) {
      // A confirm that already landed (client timeout, or a retry) leaves the
      // intent executed on-chain. Re-reading the state proves it, so don't wedge
      // the intent on a throw the network already made moot.
      if (await this.isIntentExecuted(intentPda)) {
        this.logger.log(`[${intentId}] confirm_execution already applied on-chain (idempotent)`);
        return 'ALREADY_EXECUTED';
      }
      throw err;
    }
  }

  /**
   * Read the origin IntentState's `executed` flag. The account is
   * `disc(8) ++ committedBlobId(32) ++ size(u32) ++ storageEpochs(u32) ++
   * deadline(u64) ++ sender(32) ++ nonce(u64) ++ executed(bool) ++ ...`, so the
   * flag sits at byte offset 96. Returns false if the account is missing or the
   * read fails (caller then surfaces the original error).
   */
  private async isIntentExecuted(intentPda: PublicKey): Promise<boolean> {
    try {
      const acc = await this.connection!.getAccountInfo(intentPda, 'confirmed');
      return acc !== null && acc.data.length > 96 && acc.data[96] === 1;
    } catch {
      return false;
    }
  }

  /**
   * Latest confirmed signature for the adapter program, or undefined if it has no
   * history yet. Used to seed the watcher cursor so it tracks intents from now
   * forward rather than replaying the program's whole history on startup. A
   * transient RPC failure returns undefined (the first poll then seeds forward),
   * never rejecting, so a flaky public RPC cannot break startup.
   */
  async getLatestSignature(): Promise<string | undefined> {
    if (!this.connection || !this.program) return undefined;
    try {
      const sigs = await this.connection.getSignaturesForAddress(
        this.program,
        { limit: 1 },
        'confirmed',
      );
      return sigs[0]?.signature;
    } catch (err) {
      this.logger.warn(`getLatestSignature failed (${short(err)}); seeding cursor forward`);
      return undefined;
    }
  }

  /**
   * Fetch `IntentSubmitted` events emitted since `untilSignature` (exclusive),
   * oldest-first, with the newest signature seen for cursor advance. A failed
   * (errored) transaction is skipped.
   *
   * The public devnet RPC is rate-limited and lags; any RPC error is caught and
   * the prior cursor is returned unchanged, so the batch is retried next cycle
   * and a transient failure never advances past unprocessed intents nor crashes
   * the relayer (mirrors the EVM poll's own error handling).
   */
  async pollIntentSubmitted(untilSignature?: string): Promise<SolanaSubmitPoll> {
    if (!this.connection || !this.program) return { events: [], newestSignature: untilSignature };

    try {
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
    } catch (err) {
      this.logger.warn(`pollIntentSubmitted failed (${short(err)}); retrying next cycle`);
      return { events: [], newestSignature: untilSignature };
    }
  }
}
