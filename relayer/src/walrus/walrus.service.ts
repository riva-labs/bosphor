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
  private relayUrl!: string;
  private storeEpochs!: number;

  constructor(
    private readonly config: ConfigService,
    private readonly sui: SuiService,
  ) {}

  onModuleInit() {
    this.relayUrl = this.config.getOrThrow<string>('WALRUS_RELAY_URL');
    this.storeEpochs = this.config.get<number>('WALRUS_STORE_EPOCHS', 5);

    this.logger.log(`Walrus relay: ${this.relayUrl}`);
  }

  async upload(data: Buffer): Promise<WalrusBlobInfo> {
    const relayerAddress = this.sui.getAddress();
    const url = `${this.relayUrl}/v1/blobs?epochs=${this.storeEpochs}&deletable=true&send_object_to=${relayerAddress}`;

    const maxAttempts = 3;
    const baseDelay = 1000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);

      try {
        const res = await fetch(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(data),
          signal: controller.signal,
        });

        if (res.status >= 500 && attempt < maxAttempts) {
          const body = await res.text();
          this.logger.warn(
            `Walrus upload attempt ${attempt}/${maxAttempts} got ${res.status}: ${body}`,
          );
          await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
          continue;
        }

        if (!res.ok) {
          const body = await res.text();
          throw new Error(`Walrus upload failed (${res.status}): ${body}`);
        }

        const responseData = (await res.json()) as Record<string, any>;

        if (responseData.newlyCreated) {
          const blob = responseData.newlyCreated.blobObject;
          return {
            blobId: blob.blobId,
            suiObjectId: blob.id,
            endEpoch: blob.storage?.endEpoch ?? 0,
          };
        }

        if (responseData.alreadyCertified) {
          return {
            blobId: responseData.alreadyCertified.blobId,
            suiObjectId: '',
            endEpoch: responseData.alreadyCertified.endEpoch ?? 0,
          };
        }

        throw new Error(`Unexpected Walrus response: ${JSON.stringify(responseData)}`);
      } catch (err: any) {
        if (err.name === 'AbortError') {
          this.logger.error(`Walrus upload attempt ${attempt}/${maxAttempts} timed out`);
        }
        if (attempt === maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt - 1)));
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error('Unreachable');
  }

  async findBlobObject(blobId: string): Promise<string> {
    return this.sui.findBlobObject(blobId);
  }
}
