import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

const ADAPTER_ABI = [
  'event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)',
  'event IntentExecuted(bytes32 indexed intentId, bytes proof)',
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

/** The two EVM-side lifecycle bookend events, with the tx hash that carried them. */
export interface EvmLifecycleEvents {
  submitted: { intentId: string; sender: string; txHash: string }[];
  executed: { intentId: string; txHash: string }[];
  newFromBlock: number;
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

  async pollEvents(fromBlock: number): Promise<{ events: EvmIntentEvent[]; newFromBlock: number }> {
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

      const { intentId, sender, targetChainId, payload, nonce, deadline } = parsed.args;
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

  /**
   * Fetch the EVM-side lifecycle bookend events (IntentSubmitted, IntentExecuted)
   * since `fromBlock`, each with the tx hash that emitted it. Used by the
   * lifecycle watcher to populate the public feed; does not drive fulfillment.
   */
  async pollLifecycleEvents(fromBlock: number): Promise<EvmLifecycleEvents> {
    const latestBlock = await this.provider.getBlockNumber();
    if (fromBlock > latestBlock) {
      return { submitted: [], executed: [], newFromBlock: fromBlock };
    }

    const [submittedLogs, executedLogs] = await Promise.all([
      this.adapter.queryFilter(this.adapter.filters.IntentSubmitted(), fromBlock, latestBlock),
      this.adapter.queryFilter(this.adapter.filters.IntentExecuted(), fromBlock, latestBlock),
    ]);

    const submitted = submittedLogs
      .map((log) => {
        const parsed = this.adapter.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (!parsed) return null;
        return {
          intentId: parsed.args.intentId as string,
          sender: parsed.args.sender as string,
          txHash: log.transactionHash,
        };
      })
      .filter((e): e is EvmLifecycleEvents['submitted'][number] => e !== null);

    const executed = executedLogs
      .map((log) => {
        const parsed = this.adapter.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (!parsed) return null;
        return { intentId: parsed.args.intentId as string, txHash: log.transactionHash };
      })
      .filter((e): e is EvmLifecycleEvents['executed'][number] => e !== null);

    return { submitted, executed, newFromBlock: latestBlock + 1 };
  }

  async confirmExecution(intentId: string, proof: string): Promise<string> {
    const maxAttempts = 3;
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tx = await this.adapter.confirmExecution(intentId, ethers.toUtf8Bytes(proof));
        const receipt = await tx.wait();
        this.logger.log(`[${intentId}] EVM confirm tx: ${receipt.hash} (attempt ${attempt})`);
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
