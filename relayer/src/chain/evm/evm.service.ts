import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ethers } from 'ethers';
import {
  EVM_BOOTSTRAP_BACKOFF_BASE_MS,
  EVM_BOOTSTRAP_MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
} from '../../common';
import { ErrorReporter } from '../../observability/error-reporter';
import { isTransientRpcError } from '../../observability/transient-rpc-error';
import {
  bumpFeeOverrides,
  FeeOverrides,
  initialFeeOverrides,
  isNonceConflictError,
  MAX_FEE_BUMPS,
} from './nonce-conflict';

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

  /**
   * Per-wallet send serialization (#364). Every state-changing send from the
   * relayer wallet chains off this promise so only one tx builds+sends at a
   * time. Without it, concurrent return legs (Promise.allSettled in the
   * processor tick) and any external tool sharing EVM_RELAYER_KEY allocate the
   * same pending nonce and collide in the mempool (REPLACEMENT_UNDERPRICED),
   * then the losing tx's nonce mines out from under it (NONCE_EXPIRED). The
   * chain forces sequential nonce allocation in-process.
   */
  private sendQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: ConfigService,
    private readonly errorReporter: ErrorReporter,
  ) {}

  onModuleInit() {
    const rpcUrl = this.config.getOrThrow<string>('EVM_RPC_URL');
    const privateKey = this.config.getOrThrow<string>('EVM_RELAYER_KEY');
    const adapterAddress = this.config.getOrThrow<string>('EVM_ADAPTER_ADDRESS');

    const chainId = this.config.get<number>('EVM_CHAIN_ID') ?? 11155111;

    // Pin the network explicitly: with staticNetwork alone (no network arg)
    // ethers still probes eth_chainId once at startup, and on a flaky RPC that
    // probe times out and escapes as an uncaught "failed to bootstrap network
    // detection" NETWORK_ERROR (the 2026-08-31 testnet relayer crash). With
    // both set, the provider starts with the network already known and never
    // performs runtime network discovery.
    this.provider = new ethers.JsonRpcProvider(rpcUrl, chainId, {
      staticNetwork: true,
      polling: true,
    });
    // The background block poller (needed by tx.wait) makes RPC calls that
    // reject on transient public-RPC errors (520, timeout). Give ethers an
    // error listener so those are logged here as warnings instead of bubbling
    // up as unhandled rejections. Everything is still reported: Sentry's
    // beforeSend hook downgrades transient RPC errors to a single grouped
    // warning, so real provider faults stay visible without the noise.
    this.provider.on('error', (err) => {
      const message = (err as Error)?.message ?? String(err);
      if (isTransientRpcError(err)) {
        this.logger.warn(`EVM provider error (transient, retrying): ${message}`);
      } else {
        this.logger.error(`EVM provider error: ${message}`);
      }
      this.errorReporter.captureException(err);
    });
    this.wallet = new ethers.Wallet(privateKey, this.provider);
    this.adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, this.wallet);

    this.logger.log(`EVM adapter: ${adapterAddress}`);
    this.logger.log(`EVM relayer: ${this.wallet.address}`);
  }

  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /**
   * First RPC touch at startup. A transient blip on the endpoint (request
   * timeout, 5xx, connection reset) retries with capped exponential backoff
   * instead of rejecting, because the callers sit in Nest onModuleInit hooks
   * where an escaped rejection kills the whole process. Non-transient errors
   * (bad URL, auth) and a still-dead endpoint after the bounded attempts still
   * throw: at that point a restart with a fresh window is the right move.
   */
  async bootstrapBlockNumber(): Promise<number> {
    let backoffMs = EVM_BOOTSTRAP_BACKOFF_BASE_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.provider.getBlockNumber();
      } catch (err) {
        if (!isTransientRpcError(err) || attempt >= EVM_BOOTSTRAP_MAX_ATTEMPTS) throw err;
        this.logger.warn(
          `EVM bootstrap attempt ${attempt}/${EVM_BOOTSTRAP_MAX_ATTEMPTS} failed ` +
            `(${(err as Error)?.message?.slice(0, 120) ?? err}); retrying in ${backoffMs}ms`,
        );
        // Grouped as a transient warning by the Sentry beforeSend hook.
        this.errorReporter.captureException(err);
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  /**
   * Owner-gated hybrid return path: mark the intent executed on EVM directly.
   * `proof` is the 0x-hex ABI encoding `abi.encode(bytes32 blobId, uint256 endEpoch)`,
   * i.e. the exact bytes the LZ return path would have delivered, so the emitted
   * `IntentExecuted` proof decodes identically for consumers.
   */
  async confirmExecution(intentId: string, proof: string): Promise<string> {
    return this.serialize(() => this.sendConfirmExecution(intentId, proof));
  }

  /**
   * Run `task` after every previously-queued send from this wallet has settled,
   * so nonces are allocated strictly in order (#364). The queue tail advances
   * regardless of whether a task resolves or rejects, so one failed send never
   * wedges the wallet.
   */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.sendQueue.then(task, task);
    // Swallow the result on the tail so a rejection here is not an unhandled
    // rejection; the caller still sees it through `run`.
    this.sendQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Send the owner-gated confirmExecution and wait for it to mine. On a nonce
   * conflict (REPLACEMENT_UNDERPRICED / NONCE_EXPIRED) it rebuilds the tx from
   * scratch with a freshly fetched pending nonce and bumped EIP-1559 fees, never
   * resending the cached signed bytes, because a byte-identical resend collides
   * the same way (the #364 failure loop). Transient RPC errors keep the existing
   * fixed backoff and reuse the current nonce/fees. Attempts and fee bumps are
   * both capped.
   */
  private async sendConfirmExecution(intentId: string, proof: string): Promise<string> {
    const maxAttempts = 3;
    const delayMs = 2000;
    const proofBytes = ethers.getBytes(proof);

    let fees: FeeOverrides = await initialFeeOverrides(this.provider);
    let nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
    let feeBumps = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const tx = await this.adapter.confirmExecution(intentId, proofBytes, {
          nonce,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        const receipt = await tx.wait();
        this.logger.log(
          `[${intentId}] EVM confirm tx: ${receipt.hash} (attempt ${attempt}, nonce ${nonce})`,
        );
        return receipt.hash;
      } catch (err) {
        this.logger.error(
          `[${intentId}] EVM confirm attempt ${attempt}/${maxAttempts} failed ` +
            `(nonce ${nonce}): ${err}`,
        );
        if (attempt === maxAttempts) throw err;

        if (isNonceConflictError(err)) {
          // Rebuild, never resend: refresh the pending nonce (a competitor may
          // have mined) and bump fees so the replacement clears the client's
          // replacement floor.
          nonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
          if (feeBumps < MAX_FEE_BUMPS) {
            fees = bumpFeeOverrides(fees);
            feeBumps++;
          }
          this.logger.warn(
            `[${intentId}] nonce conflict; rebuilding with nonce ${nonce}, ` +
              `maxFeePerGas ${fees.maxFeePerGas} (bump ${feeBumps}/${MAX_FEE_BUMPS})`,
          );
          // No fixed sleep: the collision is resolved by the rebuild, not by time.
          continue;
        }

        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    throw new Error('Unreachable');
  }
}
