import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuiClient } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { ethers } from 'ethers';

const SUI_CLOCK_OBJECT = '0x6';
const WALRUS_PACKAGE_ID =
  '0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66';

export interface SuiEventCursor {
  txDigest: string;
  eventSeq: string;
}

export interface SuiLzEvent {
  intentId: string;
  payload: number[];
  srcEid: number;
  nonce: bigint;
}

@Injectable()
export class SuiService implements OnModuleInit {
  private readonly logger = new Logger(SuiService.name);
  private client!: SuiClient;
  private keypair!: Ed25519Keypair;
  private packageId!: string;
  private configId!: string;
  private lzPackageId!: string;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const rpcUrl = this.config.getOrThrow<string>('SUI_RPC_URL');
    const relayerKey = this.config.getOrThrow<string>('SUI_RELAYER_KEY');
    this.packageId = this.config.getOrThrow<string>('SUI_PACKAGE_ID');
    this.configId = this.config.getOrThrow<string>('SUI_CONFIG_ID');
    this.lzPackageId = this.config.get<string>('SUI_LZ_PACKAGE_ID', '');

    this.client = new SuiClient({ url: rpcUrl });

    if (relayerKey.startsWith('suipriv')) {
      const { schema, secretKey } = decodeSuiPrivateKey(relayerKey);
      if (schema !== 'ED25519') {
        throw new Error(`Unsupported key schema: ${schema}`);
      }
      this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
      this.keypair = Ed25519Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(relayerKey, 'base64')),
      );
    }

    this.logger.log(`Sui package: ${this.packageId}`);
    this.logger.log(`Sui LZ pkg: ${this.lzPackageId || '(not configured)'}`);
    this.logger.log(`Sui relayer: ${this.getAddress()}`);
  }

  getAddress(): string {
    return this.keypair.toSuiAddress();
  }

  getClient(): SuiClient {
    return this.client;
  }

  getLzPackageId(): string {
    return this.lzPackageId;
  }

  async getCheckpoint(): Promise<string> {
    return this.client.getLatestCheckpointSequenceNumber();
  }

  async pollLzEvents(
    cursor: SuiEventCursor | null,
  ): Promise<{
    events: SuiLzEvent[];
    newCursor: SuiEventCursor | null;
    hasMore: boolean;
  }> {
    if (!this.lzPackageId) {
      return { events: [], newCursor: cursor, hasMore: false };
    }

    const eventType = `${this.lzPackageId}::lz_receiver::IntentReceived`;
    const result = await this.client.queryEvents({
      query: { MoveEventType: eventType },
      cursor: cursor ?? undefined,
      order: 'ascending',
      limit: 50,
    });

    const events: SuiLzEvent[] = [];
    for (const event of result.data) {
      const fields = event.parsedJson as Record<string, any>;
      const intentIdBytes: number[] = fields.intent_id;
      const intentId =
        '0x' +
        intentIdBytes
          .map((b: number) => b.toString(16).padStart(2, '0'))
          .join('');

      events.push({
        intentId,
        payload: fields.payload,
        srcEid: fields.src_eid,
        nonce: fields.nonce,
      });
    }

    let newCursor = cursor;
    if (result.hasNextPage && result.nextCursor) {
      newCursor = result.nextCursor as SuiEventCursor;
    } else if (result.data.length > 0) {
      const last = result.data[result.data.length - 1];
      newCursor = {
        txDigest: last.id.txDigest,
        eventSeq: last.id.eventSeq,
      };
    }

    return { events, newCursor, hasMore: result.hasNextPage };
  }

  async executeStore(
    intentId: string,
    sender: string,
    blobObjectId: string,
    deadlineMs: bigint,
  ): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::walrus_executor::execute_store`,
      arguments: [
        tx.object(this.configId),
        tx.pure.vector('u8', Array.from(ethers.getBytes(intentId))),
        tx.object(blobObjectId),
        tx.pure.u64(deadlineMs),
        tx.object(SUI_CLOCK_OBJECT),
        tx.pure.address(sender),
      ],
    });

    const result = await this.client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
      options: { showEffects: true },
    });

    const status = result.effects?.status?.status;
    if (status !== 'success') {
      throw new Error(
        `Sui tx failed: ${JSON.stringify(result.effects?.status)}`,
      );
    }

    this.logger.log(`[${intentId}] Sui tx digest: ${result.digest}`);
    return result.digest;
  }

  async findBlobObject(blobId: string): Promise<string> {
    const objects = await this.client.getOwnedObjects({
      owner: this.getAddress(),
      filter: { StructType: `${WALRUS_PACKAGE_ID}::blob::Blob` },
      options: { showContent: true },
    });

    for (const obj of objects.data) {
      const content = obj.data?.content;
      if (content && content.dataType === 'moveObject') {
        const fields = content.fields as Record<string, any>;
        if (fields.blob_id === blobId) {
          return obj.data!.objectId;
        }
      }
    }

    throw new Error(`Blob object not found for blobId: ${blobId}`);
  }
}
