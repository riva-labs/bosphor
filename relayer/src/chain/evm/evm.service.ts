import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

const ADAPTER_ABI = [
  'event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)',
  'function confirmExecution(bytes32 intentId, bytes proof) external',
  'function executed(bytes32) view returns (bool)',
  'function quote(uint32 dstEid, bytes payload, uint256 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
  'function submitIntent(uint32 dstEid, bytes payload, uint256 deadline, bytes options) payable returns (bytes32)',
];

export interface EvmIntentEvent {
  intentId: string;
  sender: string;
  targetChainId: bigint;
  payload: string;
  nonce: bigint;
  deadline: bigint;
}

@Injectable()
export class EvmService implements OnModuleInit {
  private readonly logger = new Logger(EvmService.name);
  private provider!: ethers.JsonRpcProvider;
  private wallet!: ethers.Wallet;
  private adapter!: ethers.Contract;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const rpcUrl = this.config.getOrThrow<string>('EVM_RPC_URL');
    const privateKey = this.config.getOrThrow<string>('EVM_RELAYER_KEY');
    const adapterAddress = this.config.getOrThrow<string>('EVM_ADAPTER_ADDRESS');

    this.provider = new ethers.JsonRpcProvider(rpcUrl, undefined, {
      staticNetwork: true,
      polling: true,
    });
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, this.wallet);

    this.logger.log(`EVM adapter: ${adapterAddress}`);
    this.logger.log(`EVM relayer: ${this.wallet.address}`);
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  async pollEvents(
    fromBlock: number,
  ): Promise<{ events: EvmIntentEvent[]; newFromBlock: number }> {
    const latestBlock = await this.provider.getBlockNumber();
    if (fromBlock > latestBlock) {
      return { events: [], newFromBlock: fromBlock };
    }

    const filter = this.adapter.filters.IntentSubmitted();
    const logs = await this.adapter.queryFilter(filter, fromBlock, latestBlock);
    const events: EvmIntentEvent[] = [];

    for (const log of logs) {
      const parsed = this.adapter.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (!parsed) continue;

      const { intentId, sender, targetChainId, payload, nonce, deadline } =
        parsed.args;
      events.push({
        intentId,
        sender,
        targetChainId,
        payload,
        nonce,
        deadline,
      });
    }

    return { events, newFromBlock: latestBlock + 1 };
  }

  async confirmExecution(intentId: string, proof: string): Promise<string> {
    const maxAttempts = 3;
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tx = await this.adapter.confirmExecution(
          intentId,
          ethers.toUtf8Bytes(proof),
        );
        const receipt = await tx.wait();
        this.logger.log(
          `[${intentId}] EVM confirm tx: ${receipt.hash} (attempt ${attempt})`,
        );
        return receipt.hash;
      } catch (err) {
        this.logger.error(
          `[${intentId}] EVM confirm attempt ${attempt}/${maxAttempts} failed: ${err}`,
        );
        if (attempt === maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw new Error('Unreachable');
  }
}
