import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { ethers } from 'ethers';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';
import { WalrusService } from '../walrus/walrus.service';

const POLL_INTERVAL = 5_000;

@Injectable()
export class IntentProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IntentProcessor.name);
  private readonly processedIntents = new Map<string, number>();
  private readonly intentTtlMs: number;
  private readonly evmDstEid: number;
  private evmFromBlock = 0;
  private processing = false;
  private stopped = false;

  constructor(
    private readonly evm: EvmService,
    private readonly sui: SuiService,
    private readonly walrus: WalrusService,
    private readonly config: ConfigService,
  ) {
    this.evmDstEid = this.config.getOrThrow<number>('EVM_DST_EID');
    this.intentTtlMs = this.config.get<number>('INTENT_TTL_MS') ?? 3_600_000;
  }

  async onModuleInit() {
    this.evmFromBlock = await this.evm.getBlockNumber();
    this.logger.log(`Starting EVM poll from block ${this.evmFromBlock}`);
    this.logger.log(`Sui relayer: ${this.sui.getAddress()}`);
    this.logger.log(`LZ package: ${this.sui.getLzPackageId() || '(not configured)'}`);
    this.logger.log(`Polling EVM every ${POLL_INTERVAL / 1000}s, Sui via checkpoint stream`);

    // Register callback for Sui checkpoint streaming events, then start the
    // stream. Order matters: the callback must be set before streaming begins
    // so that backfill events are not silently dropped.
    this.sui.setOnEventCallback((event) => this.handleSuiLzEvent(event));
    this.sui.startStreaming();
  }

  async onModuleDestroy() {
    this.logger.log('Shutting down intent processor...');
    this.stopped = true;
    // Wait for any in-flight processing to complete
    while (this.processing) {
      await new Promise((r) => setTimeout(r, 100));
    }
    this.logger.log('Intent processor stopped');
  }

  @Interval(POLL_INTERVAL)
  async poll(): Promise<void> {
    if (this.stopped || this.processing) return;
    this.processing = true;
    try {
      this.pruneProcessedIntents();
      // Sui event polling replaced by checkpoint streaming (SuiService.onModuleInit)
      await this.pollEvmEvents();
    } catch (err) {
      this.logger.error(`Poll error: ${err}`);
    } finally {
      this.processing = false;
    }
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
      this.logger.log(`[${event.intentId}] Intent fulfilled (via Sui LZ)`);
    } catch (err) {
      this.logger.error(`[${event.intentId}] Intent failed: ${err}`);
    }
  }

  private async pollEvmEvents(): Promise<void> {
    const { events, newFromBlock } = await this.evm.pollEvents(this.evmFromBlock);
    this.evmFromBlock = newFromBlock;

    for (const event of events) {
      if (this.processedIntents.has(event.intentId)) {
        this.logger.debug(`[${event.intentId}] Skipping — already processed`);
        continue;
      }

      const deadlineMs = BigInt(event.deadline) * 1000n;
      if (Date.now() > Number(deadlineMs)) {
        this.logger.log(`[${event.intentId}] Skipping — deadline expired`);
        this.processedIntents.set(event.intentId, Date.now());
        continue;
      }

      this.logger.log(
        `[${event.intentId}] Intent received via EVM (sender: ${event.sender}, chain: ${event.targetChainId}, nonce: ${event.nonce})`,
      );

      try {
        const payloadBytes = ethers.getBytes(event.payload);
        await this.processIntent(
          event.intentId,
          event.sender,
          Buffer.from(payloadBytes),
          deadlineMs,
        );
        this.processedIntents.set(event.intentId, Date.now());
        this.logger.log(`[${event.intentId}] Intent fulfilled (via EVM)`);
      } catch (err) {
        this.logger.error(`[${event.intentId}] Intent failed: ${err}`);
        // Do NOT mark as processed — allow retry on next poll
      }
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
    // 1. Upload payload to Walrus
    this.logger.log(`[${intentId}] Uploading to Walrus...`);
    const walrusInfo = await this.walrus.upload(payload);
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
      if (msg.includes('execute_store') && msg.includes(', 2)')) {
        this.logger.log(`[${intentId}] execute_store already done, proceeding to LZ send`);
      } else {
        throw err;
      }
    }

    // 4. Quote LZ fee, then send proof back to EVM via LayerZero
    let feeAmount: bigint | undefined;
    try {
      const quotedFee = await this.sui.quoteLzFee(
        intentId,
        walrusInfo.blobId,
        walrusInfo.endEpoch,
        this.evmDstEid,
      );
      // Add 10% buffer to the quoted fee
      feeAmount = (quotedFee * 11n) / 10n;
      this.logger.log(
        `[${intentId}] LZ fee quote: ${quotedFee} MIST (using ${feeAmount} with buffer)`,
      );
    } catch (err) {
      this.logger.warn(`[${intentId}] LZ fee quote failed, using default: ${err}`);
    }

    this.logger.log(`[${intentId}] Sending LZ proof to EVM (dstEid: ${this.evmDstEid})...`);
    const lzDigest = await this.sui.lzSendProof(
      intentId,
      walrusInfo.blobId,
      walrusInfo.endEpoch,
      this.evmDstEid,
      ...(feeAmount !== undefined ? [feeAmount] : []),
    );
    this.logger.log(`[${intentId}] LZ proof sent: ${lzDigest}`);
  }
}
