/**
 * Runnable example: store a file with one `store()` call over the EVM path, on the
 * hosted Bosphor testnet (Ethereum Sepolia -> Sui/Walrus testnet).
 *
 * `store()` pays only the LayerZero messaging fee. For the user-pays flow that
 * escrows the storage cost, see `store-file-priced.evm.ts`.
 *
 * Not run in CI. Needs a Sepolia signer with a little ETH and the optional peers
 * `ethers`, `@mysten/walrus`, and `@mysten/sui`. Every deployment detail (adapter
 * address, LayerZero options, relayer URL, Sui endpoint id) comes from `TESTNET`.
 *
 *   RPC_URL=...            Sepolia RPC endpoint
 *   PRIVATE_KEY=0x...      funded Sepolia private key
 *   FILE=./some-file.bin   path to the file to store
 *
 * Run: node --import tsx examples/store-file.evm.ts
 */

import { readFileSync } from "node:fs";
import { ethers } from "ethers";
import { TESTNET, createBosphorClientFromSigner, walrusBlobUrl } from "@bosphor/sdk/evm";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const provider = new ethers.JsonRpcProvider(env("RPC_URL"));
  const signer = new ethers.Wallet(env("PRIVATE_KEY"), provider);
  const client = await createBosphorClientFromSigner(signer);

  const data = new Uint8Array(readFileSync(env("FILE")));
  console.log(`Storing ${data.length} bytes via one store() call...`);
  const { intentId, blobId, endEpoch, txHash } = await client.store(data, { epochs: 5 });

  console.log("Stored and verified:");
  console.log(`  intentId: ${intentId}`);
  console.log(`  blobId:   ${blobId}`);
  console.log(`  endEpoch: ${endEpoch}`);
  console.log(`  tx:       ${TESTNET.evm.explorerUrl}/tx/${txHash}`);
  console.log(`  blob:     ${walrusBlobUrl(blobId)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
