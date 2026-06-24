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
      // This is a refresh of real data, not a fabricated fallback: if the retry
      // also fails the error propagates.
      this.logger.warn(
        `Walrus upload failed, resetting SDK cache (likely Walrus epoch change) and retrying: ${err}`,
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
}
