import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const SUI_CLOCK_OBJECT = '0x6';
const WALRUS_PACKAGE_ID = '0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66';

// Default LZ options: 200_000 gas for lzReceive on EVM
const DEFAULT_LZ_OPTIONS = '0x00030100110100000000000000000000000000030d40';

interface LzInfra {
  endpointV2: string;
  endpointV2Obj: string;
  uln302: string;
  uln302Obj: string;
  executorPkg: string;
  executorObj: string;
  execFeeLib: string;
  execFeeLibObj: string;
  dvnPkg: string;
  dvnObj: string;
  dvnFeeLib: string;
  dvnFeeLibObj: string;
  priceFeed: string;
  priceFeedObj: string;
  treasury: string;
  treasuryObj: string;
}

export interface SuiLzEvent {
  intentId: string;
  payload: number[];
  srcEid: number;
  nonce: bigint;
}

const CURSOR_FILE = resolve(__dirname, '../../../.sui-checkpoint-cursor');
const MAX_BACKOFF_MS = 30_000;

@Injectable()
export class SuiService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SuiService.name);
  private client!: SuiGrpcClient;
  private keypair!: Ed25519Keypair;
  private packageId!: string;
  private configId!: string;
  private lzPackageId!: string;
  private lzConfigId!: string;
  private lzOappId!: string;
  private lzMessagingChannel!: string;
  private lzInfra!: LzInfra;
  private onEventCallback?: (event: SuiLzEvent) => Promise<void>;
  private stopped = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const grpcUrl = this.config.getOrThrow<string>('SUI_GRPC_URL');
    const relayerKey = this.config.getOrThrow<string>('SUI_RELAYER_KEY');
    this.packageId = this.config.getOrThrow<string>('SUI_PACKAGE_ID');
    this.configId = this.config.getOrThrow<string>('SUI_CONFIG_ID');
    this.lzPackageId = this.config.get<string>('SUI_LZ_PACKAGE_ID', '');
    this.lzConfigId = this.config.get<string>('SUI_LZ_CONFIG_ID', '');
    this.lzOappId = this.config.get<string>('SUI_LZ_OAPP_ID', '');
    this.lzMessagingChannel = this.config.get<string>('SUI_LZ_MESSAGING_CHANNEL', '');
    this.lzInfra = {
      endpointV2: this.config.get<string>('SUI_LZ_ENDPOINT_V2', ''),
      endpointV2Obj: this.config.get<string>('SUI_LZ_ENDPOINT_V2_OBJ', ''),
      uln302: this.config.get<string>('SUI_LZ_ULN302', ''),
      uln302Obj: this.config.get<string>('SUI_LZ_ULN302_OBJ', ''),
      executorPkg: this.config.get<string>('SUI_LZ_EXECUTOR_PKG', ''),
      executorObj: this.config.get<string>('SUI_LZ_EXECUTOR_OBJ', ''),
      execFeeLib: this.config.get<string>('SUI_LZ_EXEC_FEE_LIB', ''),
      execFeeLibObj: this.config.get<string>('SUI_LZ_EXEC_FEE_LIB_OBJ', ''),
      dvnPkg: this.config.get<string>('SUI_LZ_DVN_PKG', ''),
      dvnObj: this.config.get<string>('SUI_LZ_DVN_OBJ', ''),
      dvnFeeLib: this.config.get<string>('SUI_LZ_DVN_FEE_LIB', ''),
      dvnFeeLibObj: this.config.get<string>('SUI_LZ_DVN_FEE_LIB_OBJ', ''),
      priceFeed: this.config.get<string>('SUI_LZ_PRICE_FEED', ''),
      priceFeedObj: this.config.get<string>('SUI_LZ_PRICE_FEED_OBJ', ''),
      treasury: this.config.get<string>('SUI_LZ_TREASURY', ''),
      treasuryObj: this.config.get<string>('SUI_LZ_TREASURY_OBJ', ''),
    };

    const network = grpcUrl.includes('mainnet') ? 'mainnet' as const : 'testnet' as const;
    this.client = new SuiGrpcClient({ network, baseUrl: grpcUrl });

    // GrpcCoreClient.resolveTransactionPlugin() is not yet implemented (throws).
    // Override with a resolver that uses gRPC methods for gas and object resolution.
    const grpcClient = this.client;
    (this.client.core as any).resolveTransactionPlugin = () => {
      return async (
        transactionData: any,
        _options: any,
        next: () => Promise<void>,
      ) => {
        // Resolve gas if not set
        if (!transactionData.gasConfig.price) {
          const { referenceGasPrice } = await grpcClient.core.getReferenceGasPrice();
          transactionData.gasConfig.price = referenceGasPrice;
        }
        if (!transactionData.gasConfig.budget) {
          transactionData.gasConfig.budget = '50000000';
        }
        if (!transactionData.gasConfig.payment) {
          const coins = await grpcClient.core.getCoins({
            address: transactionData.sender,
            coinType: '0x2::sui::SUI',
          });
          if (coins.objects.length > 0) {
            transactionData.gasConfig.payment = coins.objects.slice(0, 1).map((c: any) => ({
              objectId: c.id,
              version: c.version,
              digest: c.digest,
            }));
          }
        }
        // Resolve object inputs
        const unresolvedIds: string[] = [];
        const unresolvedIndices: number[] = [];
        transactionData.inputs.forEach((input: any, idx: number) => {
          if (input.UnresolvedObject) {
            unresolvedIds.push(input.UnresolvedObject.objectId);
            unresolvedIndices.push(idx);
          }
        });
        if (unresolvedIds.length > 0) {
          const { objects } = await grpcClient.core.getObjects({ objectIds: unresolvedIds });
          for (let i = 0; i < unresolvedIds.length; i++) {
            const obj = objects[i];
            if (obj instanceof Error) continue;
            const owner = obj.owner;
            if (owner && '$kind' in owner && owner.$kind === 'Shared') {
              transactionData.inputs[unresolvedIndices[i]] = {
                $kind: 'Object',
                Object: {
                  $kind: 'SharedObject',
                  SharedObject: {
                    objectId: obj.id,
                    initialSharedVersion: owner.Shared.initialSharedVersion,
                    mutable: true,
                  },
                },
              };
            } else {
              transactionData.inputs[unresolvedIndices[i]] = {
                $kind: 'Object',
                Object: {
                  $kind: 'ImmOrOwnedObject',
                  ImmOrOwnedObject: {
                    objectId: obj.id,
                    version: obj.version,
                    digest: obj.digest,
                  },
                },
              };
            }
          }
        }
        await next();
      };
    };

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

    if (this.lzPackageId) {
      this.startCheckpointStream().catch((err) =>
        this.logger.error(`Checkpoint stream fatal error: ${err}`),
      );
    }
  }

  async onModuleDestroy() {
    this.stopped = true;
  }

  /**
   * Register a callback for IntentReceived events detected via checkpoint streaming.
   */
  setOnEventCallback(cb: (event: SuiLzEvent) => Promise<void>) {
    this.onEventCallback = cb;
  }

  getAddress(): string {
    return this.keypair.toSuiAddress();
  }

  getClient(): SuiGrpcClient {
    return this.client;
  }

  getLzPackageId(): string {
    return this.lzPackageId;
  }

  async getCheckpoint(): Promise<string> {
    const { response } = await this.client.ledgerService.getServiceInfo({});
    return response.checkpointHeight?.toString() ?? '0';
  }

  // --- Checkpoint streaming ---

  private readCursor(): bigint | null {
    try {
      const data = readFileSync(CURSOR_FILE, 'utf-8').trim();
      return BigInt(data);
    } catch {
      return null;
    }
  }

  private writeCursor(checkpoint: bigint) {
    writeFileSync(CURSOR_FILE, checkpoint.toString());
  }

  private async startCheckpointStream() {
    const lastCheckpoint = this.readCursor();
    if (lastCheckpoint !== null) {
      this.logger.log(`Resuming from checkpoint ${lastCheckpoint}`);
      await this.backfill(lastCheckpoint);
    }

    let backoffMs = 1000;
    while (!this.stopped) {
      try {
        this.logger.log('Starting checkpoint stream...');
        await this.streamCheckpoints();
        backoffMs = 1000; // reset on clean disconnect
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn(`Checkpoint stream error: ${err}. Reconnecting in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async backfill(fromCheckpoint: bigint) {
    const currentStr = await this.getCheckpoint();
    const current = BigInt(currentStr);
    if (fromCheckpoint >= current) return;

    this.logger.log(`Backfilling checkpoints ${fromCheckpoint + 1n} to ${current}`);
    for (let seq = fromCheckpoint + 1n; seq <= current; seq++) {
      if (this.stopped) break;
      const { response } = await this.client.ledgerService.getCheckpoint({
        checkpointId: { oneofKind: 'sequenceNumber' as const, sequenceNumber: seq },
        readMask: { paths: ['transactions.events'] },
      });
      if (response.checkpoint) {
        await this.processCheckpoint(response.checkpoint, seq);
      }
    }
  }

  private async streamCheckpoints() {
    const stream = this.client.subscriptionService.subscribeCheckpoints({
      readMask: { paths: ['transactions.events'] },
    });

    for await (const msg of stream.responses) {
      if (this.stopped) break;
      const checkpoint = msg.checkpoint;
      const seq = BigInt(msg.cursor ?? checkpoint?.sequenceNumber ?? 0);
      if (checkpoint) {
        await this.processCheckpoint(checkpoint, seq);
      }
    }
  }

  private async processCheckpoint(checkpoint: any, sequenceNumber: bigint) {
    const eventType = `${this.lzPackageId}::lz_receiver::IntentReceived`;
    const transactions = checkpoint.transactions ?? [];

    for (const tx of Array.isArray(transactions) ? transactions : [transactions]) {
      const eventsContainer = tx.events;
      if (!eventsContainer) continue;

      const events = eventsContainer.events ?? [];
      for (const event of events) {
        if (event.eventType !== eventType) continue;

        const json = event.json?.value;
        if (!json) continue;

        let fields: Record<string, any>;
        try {
          fields = typeof json === 'string' ? JSON.parse(json) : json;
        } catch {
          continue;
        }

        const intentIdBytes: number[] = fields.intent_id;
        if (!Array.isArray(intentIdBytes)) continue;
        const intentId =
          '0x' + intentIdBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');

        const lzEvent: SuiLzEvent = {
          intentId,
          payload: fields.payload,
          srcEid: fields.src_eid,
          nonce: BigInt(fields.nonce ?? 0),
        };

        if (this.onEventCallback) {
          await this.onEventCallback(lzEvent);
        }
      }
    }

    this.writeCursor(sequenceNumber);
  }

  /**
   * Build, sign, and execute a transaction via gRPC.
   */
  private async signAndExecute(tx: Transaction) {
    tx.setSender(this.getAddress());
    const bytes = await tx.build({ client: this.client });
    const { signature } = await this.keypair.signTransaction(bytes);
    return this.client.core.executeTransaction({
      transaction: bytes,
      signatures: [signature],
    });
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

    const result = await this.signAndExecute(tx);
    const { digest, effects } = result.transaction;

    if (!effects?.status?.success) {
      throw new Error(`Sui tx failed: ${JSON.stringify(effects?.status)}`);
    }

    this.logger.log(`[${intentId}] Sui tx digest: ${digest}`);
    return digest;
  }

  /**
   * Quote the LZ messaging fee for sending a proof back to EVM.
   *
   * Builds a 16-step quote PTB (mirrors the send PTB but with quote functions),
   * runs it via simulateTransaction with command_outputs readMask,
   * and parses the MessagingFee BCS return.
   */
  async quoteLzFee(
    intentId: string,
    blobId: string,
    endEpoch: number,
    dstEid: number,
  ): Promise<bigint> {
    if (!this.lzConfigId || !this.lzOappId || !this.lzMessagingChannel) {
      throw new Error(
        'LZ quote requires SUI_LZ_CONFIG_ID, SUI_LZ_OAPP_ID, and SUI_LZ_MESSAGING_CHANNEL',
      );
    }
    if (!this.lzInfra.endpointV2 || !this.lzInfra.uln302Obj) {
      throw new Error('LZ infrastructure not configured. Set all SUI_LZ_* env vars.');
    }

    const tx = new Transaction();
    const infra = this.lzInfra;

    const intentIdBytes = Array.from(ethers.getBytes(intentId));
    const blobIdBytes = Array.from(Buffer.from(blobId, 'base64url'));
    const optionsBytes = Array.from(ethers.getBytes(DEFAULT_LZ_OPTIONS));

    // [0] APP::quote_proof (no fee coin needed)
    const [quoteCall] = tx.moveCall({
      target: `${this.lzPackageId}::lz_receiver::quote_proof`,
      arguments: [
        tx.object(this.lzConfigId),
        tx.object(this.lzOappId),
        tx.pure.vector('u8', intentIdBytes),
        tx.pure.vector('u8', blobIdBytes),
        tx.pure.u64(endEpoch),
        tx.pure.u32(dstEid),
        tx.pure.vector('u8', optionsBytes),
      ],
    });

    // [1] endpoint_v2::quote
    const [msglibQuoteCall] = tx.moveCall({
      target: `${infra.endpointV2}::endpoint_v2::quote`,
      arguments: [tx.object(infra.endpointV2Obj), tx.object(this.lzMessagingChannel), quoteCall],
    });

    // [2] uln_302::quote
    const [execGetFeeCall, dvnGetFeeMultiCall] = tx.moveCall({
      target: `${infra.uln302}::uln_302::quote`,
      arguments: [tx.object(infra.uln302Obj), msglibQuoteCall],
    });

    // [3] executor_worker::get_fee
    const [execFlCall] = tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::get_fee`,
      arguments: [tx.object(infra.executorObj), execGetFeeCall],
    });

    // [4] exec_fee_lib::get_fee
    const [execPfCall] = tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall],
    });

    // [5] price_feed::estimate_fee_by_eid (executor)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), execPfCall],
    });

    // [6] exec_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall, execPfCall],
    });

    // [7] executor_worker::confirm_get_fee
    tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::confirm_get_fee`,
      arguments: [tx.object(infra.executorObj), execGetFeeCall, execFlCall],
    });

    // [8] dvn::get_fee
    const [dvnFlCall] = tx.moveCall({
      target: `${infra.dvnPkg}::dvn::get_fee`,
      arguments: [tx.object(infra.dvnObj), dvnGetFeeMultiCall],
    });

    // [9] dvn_fee_lib::get_fee
    const [dvnPfCall] = tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall],
    });

    // [10] price_feed::estimate_fee_by_eid (dvn)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), dvnPfCall],
    });

    // [11] dvn_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall, dvnPfCall],
    });

    // [12] dvn::confirm_get_fee
    tx.moveCall({
      target: `${infra.dvnPkg}::dvn::confirm_get_fee`,
      arguments: [tx.object(infra.dvnObj), dvnGetFeeMultiCall, dvnFlCall],
    });

    // [13] uln_302::confirm_quote
    tx.moveCall({
      target: `${infra.uln302}::uln_302::confirm_quote`,
      arguments: [
        tx.object(infra.uln302Obj),
        tx.object(infra.treasuryObj),
        msglibQuoteCall,
        execGetFeeCall,
        dvnGetFeeMultiCall,
      ],
    });

    // [14] endpoint_v2::confirm_quote
    tx.moveCall({
      target: `${infra.endpointV2}::endpoint_v2::confirm_quote`,
      arguments: [tx.object(infra.endpointV2Obj), quoteCall, msglibQuoteCall],
    });

    // [15] APP::confirm_quote_proof → returns MessagingFee
    tx.moveCall({
      target: `${this.lzPackageId}::lz_receiver::confirm_quote_proof`,
      arguments: [tx.object(this.lzConfigId), tx.object(this.lzOappId), quoteCall],
    });

    tx.setSender(this.getAddress());
    const bytes = await tx.build({ client: this.client });
    const { response } = await this.client.transactionExecutionService.simulateTransaction(
      {
        transaction: { bcs: { value: bytes } },
        readMask: { paths: ['commandOutputs'] },
      },
    );

    const outputs = response.commandOutputs ?? [];
    const lastOutput = outputs[outputs.length - 1];
    const returnValue = lastOutput?.returnValues?.[0]?.value?.value;
    if (!returnValue || returnValue.length < 16) {
      throw new Error('Failed to parse LZ fee quote: no return value');
    }

    const buf = Buffer.from(returnValue);
    const nativeFee = buf.readBigUInt64LE(0);
    return nativeFee;
  }

  /**
   * Build and execute the 16-step LZ send PTB to send a proof back to EVM.
   */
  async lzSendProof(
    intentId: string,
    blobId: string,
    endEpoch: number,
    dstEid: number,
    feeAmount: bigint = 500_000_000n,
  ): Promise<string> {
    if (!this.lzConfigId || !this.lzOappId || !this.lzMessagingChannel) {
      throw new Error(
        'LZ send proof requires SUI_LZ_CONFIG_ID, SUI_LZ_OAPP_ID, and SUI_LZ_MESSAGING_CHANNEL',
      );
    }
    if (!this.lzInfra.endpointV2 || !this.lzInfra.uln302Obj) {
      throw new Error('LZ infrastructure not configured. Set all SUI_LZ_* env vars.');
    }

    const tx = new Transaction();
    const infra = this.lzInfra;

    const intentIdBytes = Array.from(ethers.getBytes(intentId));
    const blobIdBytes = Array.from(Buffer.from(blobId, 'base64url'));
    const optionsBytes = Array.from(ethers.getBytes(DEFAULT_LZ_OPTIONS));

    // [0] SplitCoins
    const [feeCoin] = tx.splitCoins(tx.gas, [feeAmount]);

    // [1] APP::lz_send_proof
    const [call] = tx.moveCall({
      target: `${this.lzPackageId}::lz_receiver::lz_send_proof`,
      arguments: [
        tx.object(this.lzConfigId),
        tx.object(this.lzOappId),
        tx.pure.vector('u8', intentIdBytes),
        tx.pure.vector('u8', blobIdBytes),
        tx.pure.u64(endEpoch),
        tx.pure.u32(dstEid),
        tx.pure.vector('u8', optionsBytes),
        feeCoin,
      ],
    });

    // [2] endpoint_v2::send
    const [msglibCall] = tx.moveCall({
      target: `${infra.endpointV2}::endpoint_v2::send`,
      arguments: [tx.object(infra.endpointV2Obj), tx.object(this.lzMessagingChannel), call],
    });

    // [3] uln_302::send
    const [execCall, dvnMultiCall] = tx.moveCall({
      target: `${infra.uln302}::uln_302::send`,
      arguments: [tx.object(infra.uln302Obj), msglibCall],
    });

    // [4] executor::assign_job
    const [execFlCall] = tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::assign_job`,
      arguments: [tx.object(infra.executorObj), execCall],
    });

    // [5] exec_fee_lib::get_fee
    const [execPfCall] = tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall],
    });

    // [6] price_feed::estimate_fee_by_eid (executor)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), execPfCall],
    });

    // [7] exec_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.execFeeLib}::executor_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.execFeeLibObj), execFlCall, execPfCall],
    });

    // [8] executor::confirm_assign_job
    tx.moveCall({
      target: `${infra.executorPkg}::executor_worker::confirm_assign_job`,
      arguments: [tx.object(infra.executorObj), execCall, execFlCall],
    });

    // [9] dvn::assign_job
    const [dvnFlCall] = tx.moveCall({
      target: `${infra.dvnPkg}::dvn::assign_job`,
      arguments: [tx.object(infra.dvnObj), dvnMultiCall],
    });

    // [10] dvn_fee_lib::get_fee
    const [dvnPfCall] = tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall],
    });

    // [11] price_feed::estimate_fee_by_eid (dvn)
    tx.moveCall({
      target: `${infra.priceFeed}::price_feed::estimate_fee_by_eid`,
      arguments: [tx.object(infra.priceFeedObj), dvnPfCall],
    });

    // [12] dvn_fee_lib::confirm_get_fee
    tx.moveCall({
      target: `${infra.dvnFeeLib}::dvn_fee_lib::confirm_get_fee`,
      arguments: [tx.object(infra.dvnFeeLibObj), dvnFlCall, dvnPfCall],
    });

    // [13] dvn::confirm_assign_job
    tx.moveCall({
      target: `${infra.dvnPkg}::dvn::confirm_assign_job`,
      arguments: [tx.object(infra.dvnObj), dvnMultiCall, dvnFlCall],
    });

    // [14] uln_302::confirm_send
    tx.moveCall({
      target: `${infra.uln302}::uln_302::confirm_send`,
      arguments: [
        tx.object(infra.uln302Obj),
        tx.object(infra.endpointV2Obj),
        tx.object(infra.treasuryObj),
        tx.object(this.lzMessagingChannel),
        call,
        msglibCall,
        execCall,
        dvnMultiCall,
      ],
    });

    // [15] APP::confirm_lz_send_proof
    tx.moveCall({
      target: `${this.lzPackageId}::lz_receiver::confirm_lz_send_proof`,
      arguments: [tx.object(this.lzConfigId), tx.object(this.lzOappId), call],
    });

    const result = await this.signAndExecute(tx);
    const { digest, effects } = result.transaction;

    if (!effects?.status?.success) {
      throw new Error(`Sui tx failed: ${JSON.stringify(effects?.status)}`);
    }

    this.logger.log(`[${intentId}] LZ send proof tx: ${digest}`);
    return digest;
  }

  async findBlobObject(blobId: string): Promise<string> {
    const result = await this.client.stateService.listOwnedObjects({
      owner: this.getAddress(),
      objectType: `${WALRUS_PACKAGE_ID}::blob::Blob`,
      readMask: { paths: ['object_id', 'contents'] },
    });

    const targetBytes = Buffer.from(blobId, 'base64url');
    const candidates = result.response.objects ?? [];

    // Try to match blob_id from BCS contents.
    // Walrus Blob struct layout: UID (32 bytes) + stored_epoch (u32, 4 bytes) + blob_id (u256, 32 bytes)
    for (const obj of candidates) {
      if (!obj.objectId) continue;
      const contents = (obj as any).contents?.value;
      if (contents && contents.length >= 68) {
        const storedBlobId = Buffer.from(contents.slice(36, 68));
        if (storedBlobId.equals(targetBytes)) {
          return obj.objectId;
        }
      }
    }

    // Fallback: return first owned Blob if BCS matching fails
    if (candidates.length > 0 && candidates[0].objectId) {
      this.logger.warn(
        `Could not match blobId from BCS contents, returning first owned Blob: ${candidates[0].objectId}`,
      );
      return candidates[0].objectId;
    }

    throw new Error(`Blob object not found for blobId: ${blobId}`);
  }
}
