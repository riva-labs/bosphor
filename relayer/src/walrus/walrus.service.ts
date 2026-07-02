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

    // The Walrus SDK caches system state (storage price, current epoch) and only
    // auto-refreshes it for readBlob, never for writeBlob. In a long-running
    // relayer that cache goes stale at each Walrus epoch rollover (~daily on
    // testnet), and writeBlob then computes its storage-payment PTB from the
    // stale price. Depending on the stale-price arithmetic that PTB aborts with
    // a different signature each epoch -- balance::split ENotEnough (code 2) or
    // balance::destroy_zero ENonZero (code 0) -- which made signature-matching a
    // whack-a-mole that flatlined the canary at every rollover.
    //
    // Reset the cache before every upload so the payment is always computed from
    // live on-chain state, eliminating the whole class regardless of signature.
    // reset() drops the cache + objectLoader; the cost is one extra systemState()
    // fetch per upload, negligible at our cadence.
    walrusClient.walrus.reset();

    let result: Awaited<ReturnType<typeof writeBlob>>;
    try {
      result = await writeBlob();
    } catch (err) {
      // Backstop: a rollover can still land in the window between the reset above
      // and the write. Retry once for that stale-cache signature only. writeBlob
      // is NOT idempotent: a late-stage failure (after the blob was registered
      // on-chain) would, on a blind retry, mint a second blob object and pay
      // storage twice. For any other error we propagate so the intent fails loudly.
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
   * rather than a generic/transient failure. The stale storage-payment PTB aborts
   * in 0x2::balance with one of two signatures depending on the price arithmetic:
   * balance::split ENotEnough (code 2) or balance::destroy_zero ENonZero (code 0).
   * The SDK's own BehindCurrentEpoch signal is the same condition surfaced early.
   * Only these are safe to reset-and-retry, since the payment math is what went
   * stale. We match the balance function names explicitly (abort code 0 is too
   * generic across Move to key on alone).
   */
  private isStaleCacheError(err: unknown): boolean {
    const msg = String((err as { message?: unknown })?.message ?? err);
    return (
      msg.includes('balance::split') ||
      msg.includes('balance::destroy_zero') ||
      msg.includes('BehindCurrentEpoch') ||
      /MoveAbort.*\bcode:?\s*2\b/.test(msg)
    );
  }
}
