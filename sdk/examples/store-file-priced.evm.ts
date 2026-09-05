/**
 * Runnable example: PRICED store over the EVM path (the M4 user-pays flow).
 *
 * `storePriced()` fetches an all-in origin-native quote from the relayer, shows
 * the breakdown, pays the escrow + forward fee at submit, uploads, and awaits the
 * proof that releases the escrow to the relayer. Not run in CI. Needs a funded EVM
 * signer, a deployed BosphorEscrowAdapter, a running relayer, and the optional
 * peers `ethers`, `@mysten/walrus`, `@mysten/sui`.
 *
 *   RPC_URL, PRIVATE_KEY, ADAPTER_ADDRESS, RELAYER_URL, DST_EID, FILE (see env below)
 *
 * Run: node --import tsx examples/store-file-priced.evm.ts
 */

import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { BosphorEvmClient, type AdapterContract, type Hex } from "@bosphor/sdk/evm";

const ADAPTER_ABI = [
  "function submitIntent(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) payable returns (bytes32)",
  "function quote(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function executed(bytes32) view returns (bool)",
  "function committedBlobId(bytes32) view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)",
  "event IntentExecuted(bytes32 indexed intentId, bytes proof)",
];

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(env("RPC_URL"));
  const signer = new ethers.Wallet(env("PRIVATE_KEY"), provider);
  const contract = new ethers.Contract(env("ADAPTER_ADDRESS"), ADAPTER_ABI, signer);
  const adapter = contract as unknown as AdapterContract;
  adapter.queryProof = async (intentId: Hex): Promise<Hex | null> => {
    const logs = await contract.queryFilter(contract.filters.IntentExecuted(intentId));
    const last = logs[logs.length - 1];
    if (!last) return null;
    return (contract.interface.parseLog(last)?.args?.proof as Hex) ?? null;
  };

  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: env("RELAYER_URL"),
    dstEid: Number(process.env.DST_EID ?? 40378),
  });

  const data = new Uint8Array(readFileSync(env("FILE")));

  // Preview the quote before paying (also available as client.priceQuote()).
  const encoded = await client.encode(data, { epochs: 5 });
  const quote = await client.priceQuote(encoded);
  console.log("All-in quote (origin native = ETH):");
  console.log(`  escrow:   ${quote.escrowNative} wei ($${quote.breakdown.escrowUsd.toFixed(4)})`);
  console.log(`  forward:  ${quote.forwardNative} wei (LZ fee, user-direct)`);
  console.log(`  total:    ${quote.totalNative} wei ($${quote.breakdown.totalUsd.toFixed(4)})`);

  console.log(`Storing ${data.length} bytes via one storePriced() call...`);
  const result = await client.storePriced(data, { epochs: 5 });

  console.log("Stored, verified, and escrow released on proof:");
  console.log(`  intentId: ${result.intentId}`);
  console.log(`  blobId:   ${result.blobId}`);
  console.log(`  endEpoch: ${result.endEpoch}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
