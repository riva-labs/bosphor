/**
 * Runnable example: store a real file with one `store()` call over the Solana path.
 *
 * This documents the one-call flow, the SAME one-line API as the EVM example. It is
 * not run in CI. It needs a funded Solana keypair, the deployed Bosphor Solana
 * adapter (program id 7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF), the adapter
 * IDL, a running relayer, and the optional peers `@solana/web3.js`,
 * `@coral-xyz/anchor`, `@mysten/walrus`, and `@mysten/sui` installed. The live
 * round-trip requires the deployed program (HITL, out of scope for the unit tests).
 *
 *   RPC_URL=...            Solana RPC endpoint (e.g. devnet/testnet)
 *   KEYPAIR=./id.json      path to a funded Solana keypair JSON (payer)
 *   IDL=./adapter.json     path to the bosphor-adapter Anchor IDL JSON
 *   RELAYER_URL=...        relayer ingest base URL
 *   DST_EID=40378          destination LayerZero endpoint id (Sui testnet)
 *   NATIVE_FEE=...         LayerZero native fee in lamports (from a fee quote)
 *   FILE=./some-file.bin   path to the file to store
 *
 * Run: node --import tsx examples/store-file.solana.ts
 */

import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
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

  const idl = JSON.parse(readFileSync(env("IDL"), "utf8"));
  const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
  const program = new Program(idl, provider);

  // Build the default Solana backend. It derives the PDAs from the on-chain seeds,
  // sends submit_intent, parses the IntentSubmitted event for the intent id, and
  // reads the IntentState PDA for awaitProof.
  const chain = await createDefaultSolanaChain({
    connection,
    wallet: payer,
    program,
    programId: BOSPHOR_PROGRAM_ID,
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
