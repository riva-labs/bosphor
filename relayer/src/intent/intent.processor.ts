import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { ethers } from 'ethers';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';
import { SuiCheckpointService } from '../chain/sui/sui-checkpoint.service';
import { SuiLzService } from '../chain/sui/sui-lz.service';
import { WalrusService } from '../walrus/walrus.service';
import { WalTopUpService } from '../walrus/wal-topup.service';
import { MetricsService } from '../metrics/metrics.service';
import { POLL_INTERVAL_MS } from '../common/constants';

@Injectable()
export class IntentProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentProcessor.name);
  private readonly processedIntents = new Map<string, number>();
  private readonly intentTtlMs: number;
  private readonly evmDstEid: number;
  private processing = false;
  private stopped = false;

  constructor(
    private readonly evm: EvmService,
    private readonly sui: SuiService,
    private readonly suiCheckpoint: SuiCheckpointService,
    private readonly suiLz: SuiLzService,
    private readonly walrus: WalrusService,
    private readonly walTopUp: WalTopUpService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {
    this.evmDstEid = this.config.getOrThrow<number>('EVM_DST_EID');
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
   * Called by SuiService when an IntentReceived event is detected
   * via checkpoint streaming.
   */
  async handleSuiLzEvent(event: {
    intentId: string;
    payload: number[];
    srcEid: number;
  }): Promise<void> {
    if (this.processedIntents.has(event.intentId)) return;

    const payloadHex =
      '0x' + event.payload.map((b: number) => b.toString(16).padStart(2, '0')).join('');

    let sender: string;
    let userPayload: string;
    let deadlineMs: bigint;
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ['bytes32', 'address', 'bytes', 'uint256'],
        payloadHex,
      );
      sender = decoded[1];
      userPayload = decoded[2];
      deadlineMs = BigInt(decoded[3]) * 1000n;
    } catch {
      this.logger.error(`[${event.intentId}] Failed to decode ABI payload`);
      this.processedIntents.set(event.intentId, Date.now());
      return;
    }

    if (Date.now() > Number(deadlineMs)) {
      this.logger.log(`[${event.intentId}] Skipping — deadline expired (via Sui LZ)`);
      this.processedIntents.set(event.intentId, Date.now());
      return;
    }

    this.logger.log(
      `[${event.intentId}] Intent received via Sui LZ (sender: ${sender}, src_eid: ${event.srcEid})`,
    );

    try {
      const payloadBytes = ethers.getBytes(userPayload);
      await this.processIntent(event.intentId, sender, Buffer.from(payloadBytes), deadlineMs);
      this.processedIntents.set(event.intentId, Date.now());
      this.metrics.recordIntentProcessed('sui_lz', 'success');
      this.logger.log(`[${event.intentId}] Intent fulfilled (via Sui LZ)`);
    } catch (err) {
      this.metrics.recordIntentProcessed('sui_lz', 'failure');
      this.logger.error(`[${event.intentId}] Intent failed: ${err}`);
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
    payload: Buffer,
    deadlineMs: bigint,
  ): Promise<void> {
    // 0. Ensure the relayer holds enough WAL to pay for storage. Refills from
    // SUI via the Walrus exchange when low, so an exhausted WAL balance never
    // silently blocks fulfillment (a live failure mode we hit on testnet).
    await this.walTopUp.ensureWal();

    // 1. Upload payload to Walrus
    this.logger.log(`[${intentId}] Uploading to Walrus...`);
    const uploadStart = Date.now();
    const walrusInfo = await this.walrus.upload(payload);
    this.metrics.observeWalrusUpload((Date.now() - uploadStart) / 1000);
    this.logger.log(`[${intentId}] Walrus blobId: ${walrusInfo.blobId}`);
    this.logger.log(`[${intentId}] Walrus object: ${walrusInfo.suiObjectId}`);
    this.logger.log(`[${intentId}] Expires epoch: ${walrusInfo.endEpoch}`);
    this.logger.log(`[${intentId}] Verify blobId: ${walrusInfo.blobId}`);

    // 2. Record on Sui (skip if already executed from a prior attempt)
    const blobObjectId = walrusInfo.suiObjectId;
    try {
      const storeDigest = await this.sui.executeStore(intentId, sender, blobObjectId, deadlineMs);
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

    // 3. Quote the real LZ fee on-chain, then send the proof back to EVM.
    // The quoted fee is authoritative. We never substitute a fabricated
    // fallback: a bad fee either overpays (drains the relayer) or underpays
    // (the send reverts). If the quote fails, fail loudly so it gets fixed.
    let quotedFee: bigint;
    try {
      quotedFee = await this.suiLz.quoteLzFee(
        intentId,
        walrusInfo.blobId,
        walrusInfo.endEpoch,
        this.evmDstEid,
      );
    } catch (err) {
      // A failed quote means the return path did not go out. Record it on the
      // LZ-send metric so the canary dashboards alert on it, then rethrow.
      this.metrics.recordLzSend('failure');
      throw err;
    }
    // Add 10% buffer to the quoted fee for price drift between quote and send.
    const feeAmount = (quotedFee * 11n) / 10n;
    this.logger.log(
      `[${intentId}] LZ fee quote: ${quotedFee} MIST (using ${feeAmount} with buffer)`,
    );

    this.logger.log(`[${intentId}] Sending LZ proof to EVM (dstEid: ${this.evmDstEid})...`);
    let lzDigest: string;
    try {
      lzDigest = await this.suiLz.lzSendProof(
        intentId,
        walrusInfo.blobId,
        walrusInfo.endEpoch,
        this.evmDstEid,
        feeAmount,
      );
    } catch (err) {
      this.metrics.recordLzSend('failure');
      throw err;
    }
    this.metrics.recordLzSend('success');
    this.logger.log(`[${intentId}] LZ proof sent: ${lzDigest}`);
  }
}
