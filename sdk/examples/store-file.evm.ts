/**
 * Runnable example: store a real file with one `store()` call over the EVM path.
 *
 * This documents the one-call flow. It is not run in CI. It needs a funded EVM
 * signer, a deployed BosphorAdapter, a running relayer, and the optional peers
 * `ethers`, `@mysten/walrus`, and `@mysten/sui` installed.
 *
 *   RPC_URL=...            EVM RPC endpoint (e.g. Sepolia)
 *   PRIVATE_KEY=0x...      funded signer private key
 *   ADAPTER_ADDRESS=0x...  deployed BosphorAdapter address
 *   RELAYER_URL=...        relayer ingest base URL
 *   DST_EID=40378          destination LayerZero endpoint id (Sui testnet)
 *   FILE=./some-file.bin   path to the file to store
 *
 * Run: node --import tsx examples/store-file.evm.ts
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
  "function getIntentId(address,bytes32,uint32,uint8,uint32,uint64,uint64) pure returns (bytes32)",
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

  // Bridge the ethers.Contract to the client's structural adapter surface, adding
  // a queryProof that reads the exact endEpoch from the IntentExecuted event.
  const adapter = contract as unknown as AdapterContract;
  adapter.queryProof = async (intentId: Hex): Promise<Hex | null> => {
    const logs = await contract.queryFilter(
      contract.filters.IntentExecuted(intentId),
    );
    const last = logs[logs.length - 1];
    if (!last) return null;
    const parsed = contract.interface.parseLog(last);
    return (parsed?.args?.proof as Hex) ?? null;
  };

  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: env("RELAYER_URL"),
    dstEid: Number(process.env.DST_EID ?? 40378),
  });

  const data = new Uint8Array(readFileSync(env("FILE")));
  console.log(`Storing ${data.length} bytes via one store() call...`);

  const result = await client.store(data, { epochs: 5 });

  console.log("Stored and verified on-chain:");
  console.log(`  intentId: ${result.intentId}`);
  console.log(`  blobId:   ${result.blobId}`);
  console.log(`  endEpoch: ${result.endEpoch}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
