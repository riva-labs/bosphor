/**
 * Runnable example: PRICED store over the Solana path (the user-pays flow), on the
 * hosted Bosphor testnet.
 *
 * `storePriced()` fetches an all-in SOL quote from the relayer, escrows it into
 * the per-intent vault at submit, uploads the bytes, and awaits the proof that
 * releases the escrow to the relayer.
 *
 * Not run in CI. Needs a devnet keypair with SOL (a 1 KB store costs roughly
 * 0.03 SOL at current prices, including the LayerZero fee and account rent) and
 * the optional peers `@solana/web3.js`, `@mysten/walrus`, `@mysten/sui`. Install
 * `@layerzerolabs/lz-solana-sdk-v2` too for an exact LayerZero fee in the quote.
 *
 *   KEYPAIR, FILE, RPC_URL (optional)
 *
 * Run: node --import tsx examples/store-file-priced.solana.ts
 */

import { readFileSync } from "node:fs";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
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

const sol = (lamports: bigint): string => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);

async function main(): Promise<void> {
  const connection = new Connection(process.env.RPC_URL ?? TESTNET.solana.rpcUrl, "confirmed");
  const secret = Uint8Array.from(JSON.parse(readFileSync(env("KEYPAIR"), "utf8")) as number[]);
  const wallet = Keypair.fromSecretKey(secret);
  const client = await createBosphorSolanaClientFromKeypair({ connection, wallet });

  const data = new Uint8Array(readFileSync(env("FILE")));

  // Preview the quote before paying.
  const encoded = await client.encode(data, { epochs: 5 });
  const quote = await client.priceQuote(encoded);
  console.log("All-in quote:");
  console.log(`  escrow:  ${sol(quote.escrowNative)} SOL ($${quote.breakdown.escrowUsd.toFixed(4)})`);
  console.log(`  LZ fee:  ${quote.forwardIsUpperBound ? "up to " : ""}${sol(quote.forwardNative)} SOL`);
  console.log(`  total:   ${sol(quote.totalNative)} SOL ($${quote.breakdown.totalUsd.toFixed(4)})`);

  console.log(`Storing ${data.length} bytes via one storePriced() call...`);
  const result = await client.storePriced(data, {
    epochs: 5,
    onProgress: (e) => console.log(`  .. ${e.step}${e.step === "submitted" ? ` ${e.txHash}` : ""}`),
  });

  console.log("Stored, verified, and escrow released on proof:");
  console.log(`  intentId: ${result.intentId}`);
  console.log(`  blobId:   ${result.blobId}`);
  console.log(`  endEpoch: ${result.endEpoch}`);
  console.log(`  tx:       https://solscan.io/tx/${result.txHash}?cluster=devnet`);
  console.log(`  blob:     ${walrusBlobUrl(result.blobId)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
