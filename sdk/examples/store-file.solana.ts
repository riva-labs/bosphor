/**
 * Runnable example: store a file with one `store()` call over the Solana path, on
 * the hosted Bosphor testnet (Solana devnet -> Sui/Walrus testnet). The SAME
 * one-line API as the EVM example.
 *
 * `store()` pays only the LayerZero messaging fee. For the user-pays flow that
 * escrows the storage cost, see `store-file-priced.solana.ts`.
 *
 * Not run in CI. Needs a devnet keypair with some SOL and the optional peers
 * `@solana/web3.js`, `@mysten/walrus`, and `@mysten/sui`. Program id, LayerZero
 * send accounts, options, fee cap, and relayer URL all come from `TESTNET`.
 *
 *   KEYPAIR=./id.json      path to a funded devnet keypair JSON (payer)
 *   RPC_URL=...            optional devnet RPC (defaults to TESTNET.solana.rpcUrl)
 *   FILE=./some-file.bin   path to the file to store
 *
 * Run: node --import tsx examples/store-file.solana.ts
 */

import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import {
  TESTNET,
  createBosphorSolanaClientFromKeypair,
  walrusBlobUrl,
} from "@bosphor/sdk/solana";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const connection = new Connection(process.env.RPC_URL ?? TESTNET.solana.rpcUrl, "confirmed");
  const secret = Uint8Array.from(JSON.parse(readFileSync(env("KEYPAIR"), "utf8")) as number[]);
  const wallet = Keypair.fromSecretKey(secret);
  const client = await createBosphorSolanaClientFromKeypair({ connection, wallet });

  const data = new Uint8Array(readFileSync(env("FILE")));
  console.log(`Storing ${data.length} bytes via one store() call...`);
  const { intentId, blobId, endEpoch, txHash } = await client.store(data, { epochs: 5 });

  console.log("Stored and verified:");
  console.log(`  intentId: ${intentId}`);
  console.log(`  blobId:   ${blobId}`);
  console.log(`  endEpoch: ${endEpoch}`);
  console.log(`  tx:       https://solscan.io/tx/${txHash}?cluster=devnet`);
  console.log(`  blob:     ${walrusBlobUrl(blobId)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
