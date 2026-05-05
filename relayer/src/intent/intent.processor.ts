import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ethers } from 'ethers';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService, SuiEventCursor } from '../chain/sui/sui.service';
import { WalrusService } from '../walrus/walrus.service';

const POLL_INTERVAL = 5_000;

@Injectable()
export class IntentProcessor implements OnModuleInit {
  private readonly logger = new Logger(IntentProcessor.name);
  private readonly processedIntents = new Set<string>();
  private evmFromBlock = 0;
  private suiEventCursor: SuiEventCursor | null = null;

  constructor(
    private readonly evm: EvmService,
    private readonly sui: SuiService,
    private readonly walrus: WalrusService,
  ) {}

  async onModuleInit() {
    this.evmFromBlock = await this.evm.getBlockNumber();
    this.logger.log(`Starting EVM poll from block ${this.evmFromBlock}`);
    this.logger.log(`Polling every ${POLL_INTERVAL / 1000}s for events`);
    this.startPolling();
  }

  private startPolling() {
    const poll = async () => {
      try {
        // Poll Sui LZ events (primary path when configured)
        await this.pollSuiLzEvents();
        // Poll EVM events (fallback / backward-compatible)
        await this.pollEvmEvents();
      } catch (err) {
        this.logger.error(`Poll error: ${err}`);
      }
      setTimeout(poll, POLL_INTERVAL);
    };
    poll();
  }

  private async pollSuiLzEvents(): Promise<void> {
    const { events, newCursor } = await this.sui.pollLzEvents(
      this.suiEventCursor,
    );
    this.suiEventCursor = newCursor;

    for (const event of events) {
      if (this.processedIntents.has(event.intentId)) {
        continue;
      }

      // Decode ABI-encoded message: (bytes32 intentId, address sender, bytes payload, uint256 deadline)
      const payloadHex =
        '0x' +
        event.payload
          .map((b: number) => b.toString(16).padStart(2, '0'))
          .join('');

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
        this.logger.error(
          `[${event.intentId}] Failed to decode ABI payload`,
        );
        this.processedIntents.add(event.intentId);
        continue;
      }

      if (Date.now() > Number(deadlineMs)) {
        this.logger.log(
          `[${event.intentId}] Skipping — deadline expired (via Sui LZ)`,
        );
        this.processedIntents.add(event.intentId);
        continue;
      }

      this.logger.log(
        `[${event.intentId}] Intent received via Sui LZ (sender: ${sender}, src_eid: ${event.srcEid})`,
      );

      try {
        const payloadBytes = ethers.getBytes(userPayload);
        await this.processIntent(
          event.intentId,
          sender,
          Buffer.from(payloadBytes),
          deadlineMs,
        );
        this.processedIntents.add(event.intentId);
        this.logger.log(
          `[${event.intentId}] Intent fulfilled (via Sui LZ)`,
        );
      } catch (err) {
        this.logger.error(`[${event.intentId}] Intent failed: ${err}`);
        // Do NOT mark as processed — allow retry on next poll
      }
    }
  }

  private async pollEvmEvents(): Promise<void> {
    const { events, newFromBlock } = await this.evm.pollEvents(
      this.evmFromBlock,
    );
    this.evmFromBlock = newFromBlock;

    for (const event of events) {
      if (this.processedIntents.has(event.intentId)) {
        this.logger.debug(
          `[${event.intentId}] Skipping — already processed`,
        );
        continue;
      }

      const deadlineMs = BigInt(event.deadline) * 1000n;
      if (Date.now() > Number(deadlineMs)) {
        this.logger.log(
          `[${event.intentId}] Skipping — deadline expired`,
        );
        this.processedIntents.add(event.intentId);
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
        this.processedIntents.add(event.intentId);
        this.logger.log(`[${event.intentId}] Intent fulfilled (via EVM)`);
      } catch (err) {
        this.logger.error(`[${event.intentId}] Intent failed: ${err}`);
        // Do NOT mark as processed — allow retry on next poll
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
    this.logger.log(
      `[${intentId}] Walrus object: ${walrusInfo.suiObjectId}`,
    );
    this.logger.log(
      `[${intentId}] Expires epoch: ${walrusInfo.endEpoch}`,
    );
    this.logger.log(
      `[${intentId}] Verify: ${this.walrus.getAggregatorUrl()}/v1/blobs/${walrusInfo.blobId}`,
    );

    // 2. Find blob object if not returned directly
    let blobObjectId = walrusInfo.suiObjectId;
    if (!blobObjectId) {
      this.logger.log(`[${intentId}] Looking up Blob object...`);
      blobObjectId = await this.walrus.findBlobObject(walrusInfo.blobId);
      this.logger.log(`[${intentId}] Found: ${blobObjectId}`);
    }

    // 3. Record on Sui
    const suiDigest = await this.sui.executeStore(
      intentId,
      sender,
      blobObjectId,
      deadlineMs,
    );

    // 4. Confirm on EVM
    const proof = JSON.stringify({
      blobId: walrusInfo.blobId,
      suiDigest,
    });
    await this.evm.confirmExecution(intentId, proof);
  }
}
