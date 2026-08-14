/**
 * Runnable example: store a real file with one `store()` call over the Solana path.
 *
 * This documents the one-call flow, the SAME one-line API as the EVM example. It is
 * not run in CI. It needs a funded Solana keypair, the deployed Bosphor Solana
 * adapter (program id 7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF), a running
 * relayer, and the optional peers `@solana/web3.js`, `@mysten/walrus`, and
 * `@mysten/sui` installed. No Anchor IDL is required: the SDK owns the program's
 * binary interface. The live round-trip requires the deployed program (HITL, out
 * of scope for the unit tests).
 *
 *   RPC_URL=...            Solana RPC endpoint (e.g. devnet/testnet)
 *   KEYPAIR=./id.json      path to a funded Solana keypair JSON (payer)
 *   RELAYER_URL=...        relayer ingest base URL
 *   DST_EID=40378          destination LayerZero endpoint id (Sui testnet)
 *   NATIVE_FEE=...         LayerZero native fee in lamports (from a fee quote)
 *   FILE=./some-file.bin   path to the file to store
 *
 * Run: node --import tsx examples/store-file.solana.ts
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

  // Build the default Solana backend. It is Anchor-free: it encodes submit_intent
  // with the SDK's own borsh codec, derives the PDAs from the on-chain seeds, sends
  // the transaction, and reads the IntentState PDA for awaitProof. `endpointAccounts`
  // are the LayerZero send accounts assembled per the deployed LZ config (validated
  // on devnet); omitted here for brevity.
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
