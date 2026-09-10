/**
 * Runnable example: PRICED store over the Solana path (the M4 user-pays flow).
 *
 * `storePriced()` fetches an all-in SOL quote from the relayer, shows the
 * breakdown, escrows the bucket into the per-intent vault at submit, uploads, and
 * awaits the proof that releases the escrow. Not run in CI. Needs a funded Solana
 * keypair, the deployed Bosphor Solana adapter, a running relayer, and the
 * optional peers `@solana/web3.js`, `@mysten/walrus`, `@mysten/sui`.
 *
 *   RPC_URL, KEYPAIR, RELAYER_URL, DST_EID, NATIVE_FEE, FILE (see env below)
 *
 * Run: node --import tsx examples/store-file-priced.solana.ts
 */

import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import {
  BosphorSolanaClient,
  createDefaultSolanaChain,
  BOSPHOR_PROGRAM_ID,
} from "@bosphor/sdk/solana";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

async function main(): Promise<void> {
  const connection = new Connection(env("RPC_URL"), "confirmed");
  const secret = Uint8Array.from(JSON.parse(readFileSync(env("KEYPAIR"), "utf8")) as number[]);
  const payer = Keypair.fromSecretKey(secret);

  const chain = await createDefaultSolanaChain({
    connection,
    wallet: payer,
    programId: BOSPHOR_PROGRAM_ID,
    // endpointAccounts: [ ... ],
  });

  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: env("RELAYER_URL"),
    dstEid: Number(process.env.DST_EID ?? 40378),
    nativeFee: BigInt(process.env.NATIVE_FEE ?? "0"),
  });

  const data = new Uint8Array(readFileSync(env("FILE")));

  // Preview the quote before paying (also available as client.priceQuote()).
  const encoded = await client.encode(data, { epochs: 5 });
  const quote = await client.priceQuote(encoded);
  console.log("All-in quote (origin native = SOL):");
  console.log(`  escrow:  ${quote.escrowNative} lamports ($${quote.breakdown.escrowUsd.toFixed(4)})`);
  console.log(`  total:   ${quote.totalNative} lamports ($${quote.breakdown.totalUsd.toFixed(4)})`);

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
