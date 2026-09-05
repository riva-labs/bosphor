import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuiService } from '../chain/sui/sui.service';
import { computeWalCost, WalrusSystemState } from './wal-cost.calculator';

export interface WalrusBlobInfo {
  blobId: string;
  suiObjectId: string;
  endEpoch: number;
  /**
   * WAL spent to store this blob, in FROST (WAL's smallest unit). Metering hook
   * for the M4 user-pays model. The Walrus SDK writeBlob result does not surface
   * the exact charge, so we recompute it deterministically from the same fresh
   * on-chain system state the write paid against (see WalCostCalculator). It is
   * left undefined only when that computation cannot be done; callers must treat
   * undefined as "unknown cost", never as zero.
   */
  walCostMist?: bigint;
}

@Injectable()
export class WalrusService implements OnModuleInit {
  private readonly logger = new Logger(WalrusService.name);
  private storeEpochs!: number;
  private aggregatorUrl!: string;

  constructor(
    private readonly config: ConfigService,
    private readonly sui: SuiService,
  ) {}

  onModuleInit() {
    this.storeEpochs = this.config.get<number>('WALRUS_STORE_EPOCHS', 5);
    this.aggregatorUrl = this.config
      .get<string>('WALRUS_AGGREGATOR_URL', 'https://aggregator.walrus-testnet.walrus.space')
      .replace(/\/+$/, '');
  }

  /**
   * Read a blob's bytes straight from the Walrus aggregator by its base64url id.
   * Used for byte recovery (re-fetch a committed blob the client never delivered).
   * Real data only: a non-2xx response throws so the caller retries or gives up,
   * never treating a miss as empty bytes.
   */
  async fetchBlobFromAggregator(blobId: string): Promise<Buffer> {
    const res = await fetch(`${this.aggregatorUrl}/v1/blobs/${blobId}`);
    if (!res.ok) {
      throw new Error(`Walrus aggregator returned ${res.status} for blob ${blobId}`);
    }
    return Buffer.from(await res.arrayBuffer());
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

    // Recompute the exact WAL charge from the fresh system state the write paid
    // against. walrusClient caches systemState from the write we just ran, so
    // reading it back reflects the same epoch/prices, not a stale snapshot. If
    // this fails we surface undefined ("unknown cost"), never a fabricated zero.
    const walCostMist = await this.computeWalCost(data.length, walrusClient);

    return {
      blobId: result.blobId,
      suiObjectId: result.blobObject.id,
      endEpoch: result.blobObject.storage.end_epoch,
      walCostMist,
    };
  }

  /**
   * Compute the FROST cost of the store we just performed, from the live system
   * state (shard count + storage/write prices) the write used. Returns undefined
   * rather than throwing so a metering hiccup never fails an otherwise-good store;
   * the caller records it only when defined and treats undefined as unknown.
   */
  private async computeWalCost(
    dataLength: number,
    walrusClient: ReturnType<SuiService['getWalrusClient']>,
  ): Promise<bigint | undefined> {
    try {
      const sys = await walrusClient.walrus.systemState();
      const state: WalrusSystemState = {
        nShards: Number(sys.committee.n_shards),
        storagePricePerUnitSize: BigInt(sys.storage_price_per_unit_size),
        writePricePerUnitSize: BigInt(sys.write_price_per_unit_size),
      };
      return computeWalCost(dataLength, this.storeEpochs, state).totalCostFrost;
    } catch (err) {
      this.logger.warn(`Could not compute WAL storage cost (recording unknown): ${err}`);
      return undefined;
    }
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
