import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import { Interval } from '@nestjs/schedule';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService, SuiLzEvent } from '../chain/sui/sui.service';
import { SuiCheckpointService } from '../chain/sui/sui-checkpoint.service';
import { SuiLzService } from '../chain/sui/sui-lz.service';
import { SolanaService } from '../chain/solana/solana.service';
import { WalrusService } from '../walrus/walrus.service';
import { WalTopUpService } from '../walrus/wal-topup.service';
import { MetricsService } from '../metrics/metrics.service';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { HopDetails, IntentHop } from '../lifecycle/intent-lifecycle.types';
import { ErrorReporter } from '../observability/error-reporter';
import { IntentIngest, BufferedBlob } from '../ingest/intent-ingest.service';
import { blobIdMatches } from '../ingest/intent-ingest.service';
import { walrusBlobIdToField } from '../common/walrus-blob-id';
import { POLL_INTERVAL_MS } from '../common/constants';

@Injectable()
export class IntentProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentProcessor.name);
  private readonly processedIntents = new Map<string, number>();
  private readonly intentTtlMs: number;
  private readonly evmDstEid: number;
  private readonly solanaSrcEid: number;
  private processing = false;
  private stopped = false;

  constructor(
    private readonly evm: EvmService,
    private readonly sui: SuiService,
    private readonly suiCheckpoint: SuiCheckpointService,
    private readonly suiLz: SuiLzService,
    private readonly solana: SolanaService,
    private readonly walrus: WalrusService,
    private readonly walTopUp: WalTopUpService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
    private readonly lifecycle: IntentLifecycleStore,
    private readonly errorReporter: ErrorReporter,
    private readonly ingest: IntentIngest,
  ) {
    this.evmDstEid = this.config.getOrThrow<number>('EVM_DST_EID');
    this.solanaSrcEid = this.config.get<number>('SOLANA_SRC_EID') ?? 40168;
    this.intentTtlMs = this.config.get<number>('INTENT_TTL_MS') ?? 3_600_000;
  }

  async onModuleInit() {
    const block = await this.evm.getBlockNumber();
    this.logger.log(`EVM connected at block ${block}`);
    this.logger.log(`Sui relayer: ${this.sui.getAddress()}`);
    this.logger.log(`LZ package: ${this.sui.getLzPackageId() || '(not configured)'}`);
    this.logger.log(`Fulfilling intents via Sui checkpoint stream (LayerZero delivery)`);

    // Register callback for Sui checkpoint streaming events, then start the
    // stream. Order matters: the callback must be set before streaming begins
    // so that backfill events are not silently dropped.
    this.suiCheckpoint.setOnEventCallback((event) => this.handleSuiLzEvent(event));
    this.suiCheckpoint.startStreaming();
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down intent processor...');
    this.stopped = true;
    this.suiCheckpoint.stop();
    // Wait for any in-flight processing to complete
    while (this.processing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.logger.log('Intent processor stopped');
  }

  @Interval(POLL_INTERVAL_MS)
  poll(): void {
    if (this.stopped) return;
    // Intents are fulfilled from the Sui LZ event (the canonical LayerZero
    // delivery). This interval only prunes the dedup map. The EVM poll was
    // removed because lz_send_proof aborts EIntentNotReceived when it runs
    // before the intent has been delivered to Sui (issue #138).
    this.pruneProcessedIntents();
  }

  /**
   * Called by SuiCheckpointService when an IntentReceived event is detected.
   *
   * M3 (#238): the event no longer carries the blob bytes, only the committed
   * reference. The bytes arrive out-of-band via the ingest endpoint and are
   * buffered by IntentIngest. Storage happens only here, after IntentReceived
   * (the reorg guard): if the bytes have not been ingested yet the event is a
   * no-op and is retried on the next checkpoint pass, so the intent naturally
   * expires at its deadline if bytes never arrive. Nothing is fabricated.
   */
  async handleSuiLzEvent(event: SuiLzEvent): Promise<void> {
    if (this.processedIntents.has(event.intentId)) return;

    const deadlineMs = event.deadline * 1000n;
    if (Date.now() > Number(deadlineMs)) {
      this.logger.log(`[${event.intentId}] Skipping - deadline expired (via Sui LZ)`);
      this.processedIntents.set(event.intentId, Date.now());
      this.ingest.drop(event.intentId);
      return;
    }

    // The bytes must already be ingested and bound to the commitment. If not,
    // do NOT mark processed: wait for ingest and retry on the next pass.
    const buffered = this.ingest.peek(event.intentId);
    if (!buffered) {
      this.logger.log(
        `[${event.intentId}] IntentReceived but no ingested bytes yet - waiting for out-of-band upload`,
      );
      return;
    }

    // original_sender for execute_store comes from the EVM commitment recorded
    // at submit. Without it we cannot transfer the blob to the right address.
    const commitment = await this.lifecycle.getCommitment(event.intentId);
    const sender = commitment?.sender;
    if (!sender) {
      this.logger.warn(
        `[${event.intentId}] IntentReceived but no committed sender recorded yet - waiting`,
      );
      return;
    }

    this.logger.log(`[${event.intentId}] Intent received via Sui LZ (src_eid: ${event.srcEid})`);
    await this.trackHop(event.intentId, 'received', { sender });

    try {
      await this.processIntent(
        event.intentId,
        sender,
        buffered,
        deadlineMs,
        event.committedBlobId,
        event.srcEid,
      );
      this.processedIntents.set(event.intentId, Date.now());
      this.ingest.drop(event.intentId);
      this.metrics.recordIntentProcessed('sui_lz', 'success');
      this.logger.log(`[${event.intentId}] Intent fulfilled (via Sui LZ)`);
    } catch (err) {
      this.metrics.recordIntentProcessed('sui_lz', 'failure');
      this.logger.error(`[${event.intentId}] Intent failed: ${err}`);
      this.errorReporter.captureException(err, { intentId: event.intentId });
    }
  }

  private pruneProcessedIntents(): void {
    const now = Date.now();
    for (const [id, timestamp] of this.processedIntents) {
      if (now - timestamp > this.intentTtlMs) {
        this.processedIntents.delete(id);
      }
    }
  }

  private async processIntent(
    intentId: string,
    sender: string,
    buffered: BufferedBlob,
    deadlineMs: bigint,
    committedBlobIdFromEvent: string,
    srcEid: number,
  ): Promise<void> {
    // 0. Ensure the relayer holds enough WAL to pay for storage. Refills from
    // SUI via the Walrus exchange when low, so an exhausted WAL balance never
    // silently blocks fulfillment (a live failure mode we hit on testnet).
    await this.walTopUp.ensureWal();

    // 1. Re-verify the recomputed blob id equals the committed id BEFORE
    // spending WAL. Ingest already checked this, but the check is cheap and
    // guards against a stale/tampered buffer between accept and store. Prefer
    // the on-chain commitment recorded at submit; fall back to the event's
    // committed id (u256 decimal) if the EVM commitment is unavailable.
    const commitment = await this.lifecycle.getCommitment(intentId);
    const committedRef = commitment?.committedBlobId ?? u256ToHex(committedBlobIdFromEvent);
    if (!blobIdMatches(buffered.blobId, committedRef)) {
      throw new Error(
        `[${intentId}] Refusing to store: buffered blob id ${buffered.blobId} no longer ` +
          `matches committed reference ${committedRef}`,
      );
    }

    // 2. Upload the ingested bytes to Walrus
    this.logger.log(`[${intentId}] Uploading ingested bytes to Walrus...`);
    const uploadStart = Date.now();
    const walrusInfo = await this.walrus.upload(buffered.bytes);
    this.metrics.observeWalrusUpload((Date.now() - uploadStart) / 1000);
    this.logger.log(`[${intentId}] Walrus blobId: ${walrusInfo.blobId}`);
    this.logger.log(`[${intentId}] Walrus object: ${walrusInfo.suiObjectId}`);
    this.logger.log(`[${intentId}] Expires epoch: ${walrusInfo.endEpoch}`);

    // Metering hook: record the per-intent WAL cost for the M4 user-pays model.
    // The SDK does not surface the exact charge yet, so walCostMist may be
    // undefined ("unknown cost"); we record it when present and never fabricate.
    if (walrusInfo.walCostMist !== undefined) {
      this.metrics.recordWalStorageCost(Number(walrusInfo.walCostMist));
    }
    await this.trackHop(intentId, 'stored_walrus', {
      blobId: walrusInfo.blobId,
      suiObjectId: walrusInfo.suiObjectId,
      endEpoch: walrusInfo.endEpoch,
      walCostMist: walrusInfo.walCostMist?.toString(),
    });

    // 3. Record on Sui (skip if already executed from a prior attempt)
    const blobObjectId = walrusInfo.suiObjectId;
    let storeDigest: string | undefined;
    try {
      storeDigest = await this.sui.executeStore(intentId, sender, blobObjectId, deadlineMs);
      // Wait for TX finality to avoid object version conflicts on the next TX
      await this.sui.getClient().core.waitForTransaction({ digest: storeDigest });
    } catch (err) {
      const msg = String(err);
      // EIntentAlreadyExecuted (abort code 2) means a prior attempt already
      // recorded this intent on Sui; proceed to the LZ send. Match both the
      // legacy "..., 2)" and the gRPC "abort code: 2" error formats.
      if (
        msg.includes('execute_store') &&
        (msg.includes(', 2)') || msg.includes('abort code: 2'))
      ) {
        this.logger.log(`[${intentId}] execute_store already done, proceeding to LZ send`);
      } else {
        throw err;
      }
    }
    await this.trackHop(intentId, 'recorded_sui', { txHash: storeDigest });

    // 4. Return path: deliver the execution proof back to the ORIGIN chain. A
    // Solana-origin intent (src_eid = solanaSrcEid) must be confirmed on Solana,
    // not EVM: the EVM adapter has no record of it and confirmExecution would
    // revert. Route by origin.
    if (srcEid === this.solanaSrcEid) {
      const canonicalBlobIdHex = '0x' + walrusBlobIdToField(walrusInfo.blobId).toString('hex');
      await this.returnToSolana(intentId, canonicalBlobIdHex, walrusInfo.endEpoch);
      return;
    }

    // EVM origin: send the proof back over LayerZero. The quoted fee is
    // authoritative (never a fabricated fallback). If the LZ send path is
    // unavailable, fall back to the owner-gated confirmExecution hybrid path so
    // the EVM intent still gets marked executed with the identical proof bytes
    // (abi.encode(blobId, endEpoch)).
    try {
      const quotedFee = await this.suiLz.quoteLzFee(
        intentId,
        walrusInfo.blobId,
        walrusInfo.endEpoch,
        this.evmDstEid,
      );
      // Add 10% buffer to the quoted fee for price drift between quote and send.
      const feeAmount = (quotedFee * 11n) / 10n;
      this.logger.log(
        `[${intentId}] LZ fee quote: ${quotedFee} MIST (using ${feeAmount} with buffer)`,
      );
      this.logger.log(`[${intentId}] Sending LZ proof to EVM (dstEid: ${this.evmDstEid})...`);
      const lzDigest = await this.suiLz.lzSendProof(
        intentId,
        walrusInfo.blobId,
        walrusInfo.endEpoch,
        this.evmDstEid,
        feeAmount,
      );
      this.metrics.recordLzSend('success');
      this.logger.log(`[${intentId}] LZ proof sent: ${lzDigest}`);
      await this.trackHop(intentId, 'proof_sent', { txHash: lzDigest });
    } catch (lzErr) {
      this.metrics.recordLzSend('failure');
      this.logger.warn(
        `[${intentId}] LZ send-proof unavailable (${(lzErr as Error).message}); ` +
          `falling back to owner confirmExecution`,
      );
      // Build the same proof the LZ return would deliver: abi.encode(blobId, endEpoch)
      // with the canonical big-endian blob id, so IntentExecuted decodes identically.
      const canonicalBlobIdHex = '0x' + walrusBlobIdToField(walrusInfo.blobId).toString('hex');
      const proof = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256'],
        [canonicalBlobIdHex, BigInt(walrusInfo.endEpoch)],
      );
      const evmDigest = await this.evm.confirmExecution(intentId, proof);
      this.logger.log(`[${intentId}] Return confirmed via confirmExecution: ${evmDigest}`);
      await this.trackHop(intentId, 'proof_sent', { txHash: evmDigest });
    }
  }

  /**
   * Solana-origin return leg: record the execution result on the origin
   * IntentState via the adapter's owner-gated confirm_execution. The canonical LZ
   * proof path (Sui -> Solana lz_receive) is blocked by the same LZ testnet infra
   * fault as the EVM leg (#272), so the trusted relayer confirms directly, still
   * asserting on-chain that the returned blob id matches the commitment.
   */
  private async returnToSolana(
    intentId: string,
    canonicalBlobIdHex: string,
    endEpoch: number,
  ): Promise<void> {
    if (!this.solana.canConfirm()) {
      this.metrics.recordLzSend('failure');
      throw new Error(
        `[${intentId}] Solana-origin return leg requires a Solana signer ` +
          `(set SOLANA_RELAYER_KEYPAIR); cannot confirm_execution`,
      );
    }
    this.logger.log(`[${intentId}] Confirming execution on Solana (src_eid: ${this.solanaSrcEid})...`);
    const sig = await this.solana.confirmExecution(intentId, canonicalBlobIdHex, BigInt(endEpoch));
    this.metrics.recordLzSend('success');
    this.logger.log(`[${intentId}] Solana return confirmed: ${sig}`);
    await this.trackHop(intentId, 'proof_sent', { txHash: sig });
  }

  /**
   * Record a lifecycle hop for the public feed. Best-effort: a store failure is
   * logged but never propagates, so feed persistence can never break intent
   * fulfillment.
   */
  private async trackHop(intentId: string, hop: IntentHop, details?: HopDetails): Promise<void> {
    try {
      await this.lifecycle.recordHop(intentId, hop, details);
    } catch (err) {
      this.logger.warn(`[${intentId}] Failed to record ${hop} hop: ${err}`);
    }
  }
}

/**
 * Convert a big-endian u256 (decimal string from the on-chain event) into a
 * 0x-prefixed 32-byte hex string, so it can be compared to a recomputed blob id
 * the same way the EVM commitment is.
 */
function u256ToHex(decimal: string): string {
  try {
    const hex = BigInt(decimal).toString(16).padStart(64, '0');
    return '0x' + hex;
  } catch {
    return '0x' + '00'.repeat(32);
  }
}
