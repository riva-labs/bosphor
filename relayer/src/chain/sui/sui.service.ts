import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { walrus } from '@mysten/walrus';
import { ethers } from 'ethers';
import { SUI_CLOCK_OBJECT } from '../../common/constants';

/** Ceiling (MIST) the relayer will pay as a Walrus upload-relay tip. Mainnet
 * tips have been observed around 2.58M MIST, above the SDK-default 1M cap that
 * rejected them with "Tip amount exceeds maximum", so this stays well clear. */
export const WALRUS_SEND_TIP_MAX_MIST = 20_000_000;

export interface LzInfra {
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

/**
 * Which `walrus_executor::execute_store` signature the configured package has.
 *
 * - `committed-deadline` (#374): the executor reads the committed deadline from
 *   `LzReceiverConfig`, there is no deadline argument:
 *   `execute_store(config, lz_config, system, intent_id, blob, clock, original_sender, ctx)`.
 * - `legacy-deadline-arg` (pre-#374 packages still live until the redeploy): a
 *   relayer-supplied `deadline_ms: u64` sits between `blob` and `clock`.
 */
export type ExecuteStoreAbi = 'committed-deadline' | 'legacy-deadline-arg';

/** Minimal shape of a normalized Move parameter, as returned by getMoveFunction. */
interface MoveParam {
  body: { $kind: string };
}

/**
 * Classifies an on-chain `execute_store` from its normalized parameter list
 * (which includes the trailing `&mut TxContext`). Throws on any other shape so
 * a package mismatch fails loudly instead of sending a malformed PTB.
 */
export function executeStoreAbiFromParams(params: MoveParam[]): ExecuteStoreAbi {
  const kinds = params.map((p) => p.body.$kind);
  if (kinds.length === 9 && kinds[5] === 'u64') return 'legacy-deadline-arg';
  if (kinds.length === 8 && !kinds.includes('u64')) return 'committed-deadline';
  throw new Error(`Unrecognized walrus_executor::execute_store signature: [${kinds.join(', ')}]`);
}

export interface SuiLzEvent {
  intentId: string;
  /** Sui digest of the delivery tx that emitted IntentReceived (the "Delivered to Sui" proof). */
  deliveryDigest: string;
  /**
   * Committed Walrus blob id as a big-endian u256 from the on-chain event,
   * carried as a decimal string (gRPC serializes u256 as a string).
   */
  committedBlobId: string;
  /** Committed blob size in bytes. */
  size: number;
  encodingType: number;
  /**
   * Committed storage duration in Walrus epochs. Undefined only when the event
   * carries no storage_epochs field (never defaulted to a fabricated value).
   */
  storageEpochs?: number;
  /** Committed intent deadline as a unix timestamp in seconds. */
  deadline: bigint;
  srcEid: number;
  nonce: bigint;
}

@Injectable()
export class SuiService implements OnModuleInit {
  private readonly logger = new Logger(SuiService.name);
  private client!: SuiGrpcClient;
  private walrusClient!: SuiGrpcClient & { walrus: import('@mysten/walrus').WalrusClient };
  private keypair!: Ed25519Keypair;
  private packageId!: string;
  private configId!: string;
  private lzPackageId!: string;
  private lzConfigId!: string;
  private lzOappId!: string;
  private lzMessagingChannel!: string;
  private lzInfra!: LzInfra;
  private executeStoreAbi?: Promise<ExecuteStoreAbi>;

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

    const network = grpcUrl.includes('mainnet') ? ('mainnet' as const) : ('testnet' as const);
    this.client = new SuiGrpcClient({ network, baseUrl: grpcUrl });

    if (relayerKey.startsWith('suipriv')) {
      const { scheme, secretKey } = decodeSuiPrivateKey(relayerKey);
      if (scheme !== 'ED25519') {
        throw new Error(`Unsupported key scheme: ${scheme}`);
      }
      this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
      this.keypair = Ed25519Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(relayerKey, 'base64')),
      );
    }

    const walrusRelayUrl = this.config.getOrThrow<string>('WALRUS_RELAY_URL');
    this.walrusClient = this.client.$extend(
      walrus({
        // The upload relay requires a tip payment; sendTip lets the SDK fetch
        // the relay's tip-config, pay it, and attach the tx id + nonce to the
        // upload request. Without it the relay rejects with HTTP 400.
        uploadRelay: { host: walrusRelayUrl, sendTip: { max: WALRUS_SEND_TIP_MAX_MIST } },
      }),
    );

    this.logger.log(`Sui package: ${this.packageId}`);
    this.logger.log(`Sui LZ pkg: ${this.lzPackageId || '(not configured)'}`);
    this.logger.log(`Sui relayer: ${this.getAddress()}`);
  }

  getAddress(): string {
    return this.keypair.toSuiAddress();
  }

  getClient(): SuiGrpcClient {
    return this.client;
  }

  getWalrusClient() {
    return this.walrusClient;
  }

  getSigner(): Ed25519Keypair {
    return this.keypair;
  }

  getLzPackageId(): string {
    return this.lzPackageId;
  }

  getLzConfigId(): string {
    return this.lzConfigId;
  }

  getLzOappId(): string {
    return this.lzOappId;
  }

  getLzMessagingChannel(): string {
    return this.lzMessagingChannel;
  }

  getLzInfra(): LzInfra {
    return this.lzInfra;
  }

  async getCheckpoint(): Promise<string> {
    const { response } = await this.client.ledgerService.getServiceInfo({});
    return response.checkpointHeight?.toString() ?? '0';
  }

  /**
   * Build, sign, and execute a transaction via gRPC.
   */
  async signAndExecute(tx: Transaction) {
    tx.setSender(this.getAddress());
    const bytes = await tx.build({ client: this.client });
    const { signature } = await this.keypair.signTransaction(bytes);
    const result = await this.client.core.executeTransaction({
      transaction: bytes,
      signatures: [signature],
    });
    if (result.$kind === 'FailedTransaction') {
      throw new Error(`Sui tx failed: ${JSON.stringify(result.FailedTransaction.status)}`);
    }
    return result.Transaction;
  }

  /**
   * Resolves (once per process) which `execute_store` signature the configured
   * executor package exposes, so the relayer works against both the live
   * pre-#374 package and the redeployed one without a config flag. A failed
   * lookup is not cached, so the next store retries it.
   */
  getExecuteStoreAbi(): Promise<ExecuteStoreAbi> {
    if (!this.executeStoreAbi) {
      this.executeStoreAbi = this.client.core
        .getMoveFunction({
          packageId: this.packageId,
          moduleName: 'walrus_executor',
          name: 'execute_store',
        })
        .then(({ function: fn }) => {
          const abi = executeStoreAbiFromParams(fn.parameters);
          this.logger.log(`execute_store ABI: ${abi}`);
          return abi;
        })
        .catch((err: unknown) => {
          this.executeStoreAbi = undefined;
          throw err;
        });
    }
    return this.executeStoreAbi;
  }

  /**
   * Records a certified Walrus blob for an intent on Sui.
   *
   * `deadlineMs` is only sent to legacy (pre-#374) packages. The redeployed
   * executor enforces the deadline the user committed on-chain and takes no
   * deadline argument, so the relayer cannot influence it.
   */
  async executeStore(
    intentId: string,
    sender: string,
    blobObjectId: string,
    deadlineMs: bigint,
  ): Promise<string> {
    const lzConfigId = this.lzConfigId;
    const walrusSystemId = this.config.getOrThrow<string>('SUI_WALRUS_SYSTEM_ID');
    if (!lzConfigId) {
      throw new Error('execute_store requires SUI_LZ_CONFIG_ID');
    }
    const abi = await this.getExecuteStoreAbi();

    // execute_store(config, lz_config, system, intent_id, blob,
    //               [deadline_ms: legacy only], clock, original_sender, ctx)
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::walrus_executor::execute_store`,
      arguments: [
        tx.object(this.configId),
        tx.object(lzConfigId),
        tx.object(walrusSystemId),
        tx.pure.vector('u8', Array.from(ethers.getBytes(intentId))),
        tx.object(blobObjectId),
        ...(abi === 'legacy-deadline-arg' ? [tx.pure.u64(deadlineMs)] : []),
        tx.object(SUI_CLOCK_OBJECT),
        tx.pure.address(sender),
      ],
    });

    const { digest, status } = await this.signAndExecute(tx);

    if (!status.success) {
      throw new Error(`Sui tx failed: ${JSON.stringify(status)}`);
    }

    this.logger.log(`[${intentId}] Sui tx digest: ${digest}`);
    return digest;
  }
}
