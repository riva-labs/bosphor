/**
 * Step 5 (forward leg): submit a storage intent on Solana and dispatch it to Sui
 * over LayerZero. Produces a `PacketSent` on Solana that the self-DVN picks up and
 * verifies on Sui.
 *
 * Ensures the LZ outbound nonce PDA exists, builds type-3 executor options,
 * derives the canonical intent id (reading the on-chain per-sender nonce), and
 * sends `submit_intent` with the endpoint `send` accounts appended (the Store PDA
 * lands at remaining_accounts[1], as the program requires).
 *
 *   NATIVE_FEE=3000000 npm run submit-intent
 */

import { Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { findIntentSubmittedIntentId } from "../../../sdk/src/solana/program.ts";
import { defaultComputeBlob } from "../../../sdk/src/blob.ts";
import { writeFileSync } from "node:fs";
import { connection, payer, storePda } from "./config.ts";
import { DEFAULT_SUI_RECEIVER, buildInitNonceIx, buildSubmitIntentTx } from "./submit-intent-ix.ts";

const SUI_RECEIVER = process.env.SUI_RECEIVER ?? DEFAULT_SUI_RECEIVER;

const BLOB_ID = process.env.BLOB_ID ?? "0x" + "a1".repeat(32);
const SIZE = 1024;
const ENCODING_TYPE = 1;
const STORAGE_EPOCHS = 5;

async function main(): Promise<void> {
  const conn = connection();
  const admin = payer();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);

  // Real-blob mode: when DATA is set, compute the true Walrus blob id + size so
  // the relayer's execute_store reference verification passes. Otherwise use a
  // fake BLOB_ID (forward-leg / IntentReceived testing only).
  let blobIdHex = BLOB_ID;
  let size = SIZE;
  let encodingType = ENCODING_TYPE;
  let ingestData: Uint8Array | null = null;
  if (process.env.DATA) {
    ingestData = new TextEncoder().encode(process.env.DATA);
    const enc = await defaultComputeBlob(ingestData);
    blobIdHex = enc.blobId;
    size = enc.size;
    encodingType = enc.encodingType;
    console.log("real blob:", blobIdHex, "size", size, "encoding", encodingType);
  }

  const escrowAmount = BigInt(process.env.ESCROW_AMOUNT ?? "5000000"); // 0.005 SOL default
  const nativeFee = BigInt(process.env.NATIVE_FEE ?? "3000000");
  // Ensure the LZ outbound nonce PDA for this pathway exists (idempotent).
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(buildInitNonceIx(admin.publicKey, undefined, SUI_RECEIVER)), [admin], {
      commitment: "confirmed",
    });
    console.log("init_nonce: created");
  } catch (e) {
    const m = String((e as Error).message).split("\n")[0];
    console.log("init_nonce:", /already in use|0x0\b/.test(m) ? "exists" : m);
  }

  const built = await buildSubmitIntentTx(conn, {
    sender: admin.publicKey,
    blobIdHex,
    size,
    encodingType,
    storageEpochs: STORAGE_EPOCHS,
    deadline,
    nativeFee,
    escrowAmount,
    suiReceiver: SUI_RECEIVER,
  });

  console.log("Store PDA:", storePda().toBase58());
  console.log("sender nonce:", built.senderNonce.toString());
  console.log("intent id:", built.intentIdHex);
  console.log("intent PDA:", built.intent.toBase58());
  console.log("escrow PDA:", built.escrow.toBase58(), "amount:", escrowAmount.toString(), "lamports");

  console.log("native_fee:", nativeFee.toString(), "lamports");
  const sig = await sendAndConfirmTransaction(conn, built.tx, [admin], { commitment: "confirmed" });
  console.log("\nsubmit_intent confirmed:", sig);

  const parsed = await conn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const emitted = findIntentSubmittedIntentId(parsed?.meta?.logMessages ?? []);
  console.log("emitted intentId:", emitted);

  // Real-blob mode: persist the intent id + bytes so the ingest step can POST the
  // exact bytes to the relayer after the forward leg delivers (IntentReceived).
  if (ingestData) {
    const out = {
      intentId: built.intentIdHex,
      blobId: blobIdHex,
      size,
      dataB64: Buffer.from(ingestData).toString("base64"),
    };
    writeFileSync("/tmp/solana-rt.json", JSON.stringify(out));
    console.log("wrote /tmp/solana-rt.json (run the DVN, then npm run roundtrip-upload)");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
