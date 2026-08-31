import { ethers, EventLog } from 'ethers';
import { createBosphorClient, defaultComputeBlob, type AdapterContract } from '@bosphor/sdk/evm';
import { preflight, effectiveGasPriceWei } from '../preflight.ts';
import { uploadWithRetry } from '../upload.ts';
import type { ChainProbe, PreflightOutcome } from '../probe.ts';

/**
 * EVM origin probe. Wraps the real `@bosphor/sdk` EVM client and drives one
 * `encode -> quote -> submit -> upload -> awaitProof` round-trip per tick, i.e.
 * the exact path an integrator uses. The blob id is computed client-side by the
 * SDK's `@mysten/walrus`-backed `defaultComputeBlob`, so the relayer's on-ingest
 * recomputation matches byte for byte.
 */
export interface EvmProbeConfig {
  rpcUrl: string;
  adapterAddress: string;
  privateKey: string;
  relayerUrl: string;
  /** Destination LayerZero endpoint id (Sui testnet is 40378). */
  dstEid: number;
  storageEpochs: number;
  options: string;
  /** Preflight guard: skip when the sender is below this many wei. */
  minBalanceWei: bigint;
  /** Preflight guard: skip when gas price is above this many wei. */
  maxGasWei: bigint;
  /** Block window scanned for the IntentExecuted proof (RPC range-cap safe). */
  proofLookbackBlocks: number;
}

// M3 adapter ABI: submitIntent/quote take the commitment fields (no
// payload). IntentExecuted carries the abi.encode(blobId, endEpoch) proof.
const ADAPTER_ABI = [
  'event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)',
  'event IntentExecuted(bytes32 indexed intentId, bytes proof)',
  'function executed(bytes32) view returns (bool)',
  'function nonces(address) view returns (uint256)',
  'function committedBlobId(bytes32) view returns (bytes32)',
  'function quote(uint32 dstEid, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
  'function submitIntent(uint32 dstEid, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, bytes options) payable returns (bytes32)',
  'function getIntentId(address sender, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, uint64 nonce) view returns (bytes32)',
];

type AdapterWithProof = AdapterContract & {
  queryProof(intentId: `0x${string}`): Promise<`0x${string}` | null>;
};

export function createEvmProbe(cfg: EvmProbeConfig): ChainProbe {
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(cfg.privateKey, provider);
  const contract = new ethers.Contract(cfg.adapterAddress, ADAPTER_ABI, wallet);

  // Lower bound for the IntentExecuted lookup, set at submit time so awaitProof
  // scans only the recent window and stays within RPC block-range caps.
  let proofFromBlock = 0;

  // Attach the queryProof the SDK's awaitProof uses to read the exact endEpoch
  // from the IntentExecuted event. Without it the SDK fails loudly rather than
  // fabricate an epoch, so a canary must provide the real event source.
  const adapter = contract as unknown as AdapterWithProof;
  adapter.queryProof = async (intentId) => {
    const filter = contract.filters.IntentExecuted(intentId);
    const from = proofFromBlock || (await provider.getBlockNumber()) - cfg.proofLookbackBlocks;
    const logs = await contract.queryFilter(filter, Math.max(0, from), 'latest');
    if (logs.length === 0) return null;
    const ev = logs[logs.length - 1] as EventLog;
    const proof = ev.args?.proof as string | undefined;
    return (proof as `0x${string}`) ?? null;
  };

  const client = createBosphorClient({
    adapter,
    relayerUrl: cfg.relayerUrl,
    dstEid: cfg.dstEid,
    options: cfg.options as `0x${string}`,
    defaultEpochs: cfg.storageEpochs,
    computeBlob: defaultComputeBlob,
  });

  return {
    chain: 'evm',
    label: `${wallet.address} -> Sui(${cfg.dstEid})`,

    async preflight(): Promise<PreflightOutcome> {
      const pre = await preflight({
        getBalanceWei: () => provider.getBalance(wallet.address),
        getGasPriceWei: async () => effectiveGasPriceWei(await provider.getFeeData()),
        minBalanceWei: cfg.minBalanceWei,
        maxGasWei: cfg.maxGasWei,
      });
      return {
        ok: pre.ok,
        reason: pre.reason,
        balanceNative: pre.balanceEth,
        gasGwei: pre.gasGwei,
      };
    },

    async submit(): Promise<{ intentId: string }> {
      const data = new TextEncoder().encode(`bosphor-canary-evm-${Date.now()}`);
      // Pin the proof-scan floor before the tx so the IntentExecuted lookup only
      // has to cover this round-trip's blocks.
      proofFromBlock = await provider.getBlockNumber();
      const encoded = await client.encode(data);
      const fee = await client.quote(encoded);
      const { intentId } = await client.submit(encoded, fee);
      // Retry past the relayer's IntentSubmitted watch lag (404 until registered).
      await uploadWithRetry((id, d) => client.upload(id as `0x${string}`, d), intentId, data);
      return { intentId };
    },

    async awaitProof(intentId: string, maxWaitMs: number): Promise<void> {
      await client.awaitProof(intentId as `0x${string}`, { timeoutMs: maxWaitMs });
    },
  };
}
