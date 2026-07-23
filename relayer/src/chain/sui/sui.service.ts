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

export interface SuiLzEvent {
  intentId: string;
  payload: number[];
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
    this.walrusClient = this.client.$extend(walrus({
      // The upload relay requires a tip payment; sendTip lets the SDK fetch
      // the relay's tip-config, pay it, and attach the tx id + nonce to the
      // upload request. Without it the relay rejects with HTTP 400.
      uploadRelay: { host: walrusRelayUrl, sendTip: { max: WALRUS_SEND_TIP_MAX_MIST } },
    }));

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

    const { digest, status } = await this.signAndExecute(tx);

    if (!status.success) {
      throw new Error(`Sui tx failed: ${JSON.stringify(status)}`);
    }

    this.logger.log(`[${intentId}] Sui tx digest: ${digest}`);
    return digest;
  }
}
