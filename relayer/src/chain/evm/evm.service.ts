import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';

/** Blocks to stay behind head when querying logs, to tolerate load-balanced RPCs
 * whose nodes lag the one that answered getBlockNumber. */
const EVM_HEAD_LAG = 3;

const ADAPTER_ABI = [
  // M3 (#238): the intent carries only a commitment. IntentSubmitted now emits
  // the committed blobId, size, encodingType and storageEpochs instead of the
  // raw payload bytes, which reach the relayer out-of-band.
  'event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)',
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
  /** Committed Walrus blob id as a 0x hex bytes32 (M3: the on-chain commitment). */
  blobId: string;
  /** Committed blob size in bytes. */
  size: number;
  encodingType: number;
  storageEpochs: number;
  nonce: bigint;
  deadline: bigint;
}

/** The two EVM-side lifecycle bookend events, with the tx hash that carried them. */
export interface EvmLifecycleEvents {
  submitted: {
    intentId: string;
    sender: string;
    /** Committed blob id as a 0x hex bytes32. */
    blobId: string;
    /** Committed blob size in bytes. */
    size: number;
    /** Intent deadline in epoch ms (seconds on-chain, converted here). */
    deadlineMs: number;
    txHash: string;
  }[];
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
    // The background block poller (needed by tx.wait) makes RPC calls that
    // reject on transient public-RPC errors (520, timeout). Give ethers an
    // error listener so those are logged here as warnings instead of bubbling
    // up as unhandled rejections.
    this.provider.on('error', (err) => {
      this.logger.warn(
        `EVM provider error (transient, retrying): ${(err as Error)?.message ?? err}`,
      );
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
    // Query a few blocks behind head: load-balanced RPCs route consecutive calls
    // to different nodes, and a node lagging the one that returned getBlockNumber
    // rejects with -32602 "block range extends beyond current head block".
    const latestBlock = (await this.provider.getBlockNumber()) - EVM_HEAD_LAG;
    if (fromBlock > latestBlock) {
      return { events: [], newFromBlock: fromBlock };
    }

    const filter = this.adapter.filters.IntentSubmitted();
    let logs;
    try {
      logs = await this.adapter.queryFilter(filter, fromBlock, latestBlock);
    } catch (err) {
      this.logger.warn(
        `pollEvents getLogs failed (${(err as Error).message?.slice(0, 80)}); retrying next cycle`,
      );
      return { events: [], newFromBlock: fromBlock };
    }
    const events: EvmIntentEvent[] = [];

    for (const log of logs) {
      const parsed = this.adapter.interface.parseLog({
        topics: log.topics as string[],
        data: log.data,
      });
      if (!parsed) continue;

      const {
        intentId,
        sender,
        targetChainId,
        blobId,
        size,
        encodingType,
        storageEpochs,
        nonce,
        deadline,
      } = parsed.args;
      events.push({
        intentId,
        sender,
        targetChainId,
        blobId,
        size: Number(size),
        encodingType: Number(encodingType),
        storageEpochs: Number(storageEpochs),
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
    const latestBlock = (await this.provider.getBlockNumber()) - EVM_HEAD_LAG;
    if (fromBlock > latestBlock) {
      return { submitted: [], executed: [], newFromBlock: fromBlock };
    }

    let submittedLogs, executedLogs;
    try {
      [submittedLogs, executedLogs] = await Promise.all([
        this.adapter.queryFilter(this.adapter.filters.IntentSubmitted(), fromBlock, latestBlock),
        this.adapter.queryFilter(this.adapter.filters.IntentExecuted(), fromBlock, latestBlock),
      ]);
    } catch (err) {
      this.logger.warn(
        `pollLifecycleEvents getLogs failed (${(err as Error).message?.slice(0, 80)}); retrying next cycle`,
      );
      return { submitted: [], executed: [], newFromBlock: fromBlock };
    }

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
          blobId: parsed.args.blobId as string,
          size: Number(parsed.args.size),
          // On-chain deadline is unix seconds; the ingest path compares against
          // Date.now() in ms, so convert once here at the boundary.
          deadlineMs: Number(parsed.args.deadline) * 1000,
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
