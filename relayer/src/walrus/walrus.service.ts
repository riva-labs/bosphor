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

    const result = await walrusClient.walrus.writeBlob({
      blob: new Uint8Array(data),
      deletable: true,
      epochs: this.storeEpochs,
      signer,
      owner,
    });

    this.logger.log(`Walrus upload complete: blobId=${result.blobId}`);

    return {
      blobId: result.blobId,
      suiObjectId: result.blobObject.id,
      endEpoch: result.blobObject.storage.end_epoch,
    };
  }

  async findBlobObject(blobId: string): Promise<string> {
    return this.sui.findBlobObject(blobId);
  }
}
