import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuiService } from '../chain/sui/sui.service';

export interface WalrusBlobInfo {
  blobId: string;
  suiObjectId: string;
  endEpoch: number;
}

@Injectable()
export class WalrusService implements OnModuleInit {
  private readonly logger = new Logger(WalrusService.name);
  private storeEpochs!: number;

  constructor(
    private readonly config: ConfigService,
    private readonly sui: SuiService,
  ) {}

  onModuleInit() {
    this.storeEpochs = this.config.get<number>('WALRUS_STORE_EPOCHS', 5);
  }

  async upload(data: Buffer): Promise<WalrusBlobInfo> {
    const walrusClient = this.sui.getWalrusClient();
    const signer = this.sui.getSigner();
    const owner = this.sui.getAddress();

    this.logger.log(`Uploading ${data.length} bytes to Walrus via SDK...`);

    const writeBlob = () =>
      walrusClient.walrus.writeBlob({
        blob: new Uint8Array(data),
        deletable: true,
        epochs: this.storeEpochs,
        signer,
        owner,
      });

    let result: Awaited<ReturnType<typeof writeBlob>>;
    try {
      result = await writeBlob();
    } catch (err) {
      // The Walrus SDK caches system state (storage price, current epoch) and
      // only auto-refreshes it for readBlob, not writeBlob. When the Walrus
      // epoch advances, writeBlob keeps computing the storage payment from the
      // stale cached price/epoch and the payment PTB aborts in balance::split.
      // reset() drops the cache so the retry refetches live on-chain state.
      //
      // Only retry for that stale-cache signature. writeBlob is NOT idempotent:
      // a late-stage failure (after the blob was registered on-chain) would, on
      // a blind retry, mint a second blob object and pay storage twice. For any
      // other error we propagate immediately so the intent fails loudly.
      if (!this.isStaleCacheError(err)) throw err;
      this.logger.warn(
        `Walrus upload failed with a stale-cache signature (likely Walrus epoch change), ` +
          `resetting SDK cache and retrying once: ${err}`,
      );
      walrusClient.walrus.reset();
      result = await writeBlob();
    }

    this.logger.log(`Walrus upload complete: blobId=${result.blobId}`);

    return {
      blobId: result.blobId,
      suiObjectId: result.blobObject.id,
      endEpoch: result.blobObject.storage.end_epoch,
    };
  }

  /**
   * Whether a writeBlob error looks like the stale-cache / epoch-rollover abort
   * (the storage-payment PTB aborting in balance::split, or the SDK's own
   * BehindCurrentEpoch signal) rather than a generic/transient failure. Only
   * these are safe to reset-and-retry, since the payment math is what went stale.
   */
  private isStaleCacheError(err: unknown): boolean {
    const msg = String((err as { message?: unknown })?.message ?? err);
    return (
      msg.includes('balance::split') ||
      msg.includes('BehindCurrentEpoch') ||
      /MoveAbort.*\bcode:?\s*2\b/.test(msg)
    );
  }
}
