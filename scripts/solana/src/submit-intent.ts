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

import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import {
  encodeSubmitIntentData,
  findIntentSubmittedIntentId,
} from "../../../sdk/src/solana/program.ts";
import { deriveIntentId, type Commitment } from "../../../sdk/src/commitment-codec.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  BOSPHOR_PROGRAM_ID,
  ENDPOINT_ID,
  SUI_TESTNET_EID,
  ULN_ID,
  connection,
  intentPda,
  noncePda,
  payer,
  peerPda,
  storePda,
} from "./config.ts";

const SUI_RECEIVER =
  process.env.SUI_RECEIVER ??
  "0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5";

const BLOB_ID = process.env.BLOB_ID ?? "0x" + "a1".repeat(32);
const SIZE = 1024;
const ENCODING_TYPE = 1;
const STORAGE_EPOCHS = 5;

function toBytes32(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const b = Buffer.from(h, "hex");
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
}

async function main(): Promise<void> {
  const conn = connection();
  const admin = payer();
  const store = storePda();
  const peer = peerPda(store, SUI_TESTNET_EID);
  const noncePdaKey = noncePda(admin.publicKey);
  const receiver = toBytes32(SUI_RECEIVER);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 24 * 3600);

  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);
  const uln = new UlnProgram.Uln(ULN_ID);
  // sender/receiver as raw bytes: the SDK's arrayify() rejects PublicKey objects.
  const path = { sender: store.toBytes(), dstEid: SUI_TESTNET_EID, receiver: SUI_RECEIVER };

  // Read the current per-sender nonce (0 if the PDA does not exist yet). Layout:
  // 8-byte discriminator ++ nonce(u64 LE) ++ bump(u8).
  const nonceAcct = await conn.getAccountInfo(noncePdaKey);
  const senderNonce = nonceAcct
    ? new DataView(nonceAcct.data.buffer, nonceAcct.data.byteOffset).getBigUint64(8, true)
    : 0n;

  const commitment: Commitment = {
    blobId: toBytes32(BLOB_ID),
    size: SIZE,
    encodingType: ENCODING_TYPE,
    storageEpochs: STORAGE_EPOCHS,
    deadline,
  };
  const intentId = deriveIntentId(commitment, admin.publicKey.toBytes(), senderNonce);
  const intent = intentPda(intentId);

  console.log("Store PDA:", store.toBase58());
  console.log("sender nonce:", senderNonce.toString());
  console.log("intent id:", "0x" + bytesToHex(intentId));
  console.log("intent PDA:", intent.toBase58());

  // Ensure the LZ outbound nonce PDA for this pathway exists (idempotent).
  try {
    const initNonceIx = endpoint.initOAppNonce(admin.publicKey, SUI_TESTNET_EID, store, receiver);
    await sendAndConfirmTransaction(conn, new Transaction().add(initNonceIx), [admin], {
      commitment: "confirmed",
    });
    console.log("init_nonce: created");
  } catch (e) {
    const m = String((e as Error).message).split("\n")[0];
    console.log("init_nonce:", /already in use|0x0\b/.test(m) ? "exists" : m);
  }

  const options = Options.newOptions().addExecutorLzReceiveOption(200_000, 0).toBytes();

  // The LZ SDK bundles its own @solana/web3.js; normalize returned pubkeys to our
  // copy so Transaction serialization doesn't mix two PublicKey classes.
  const rawSendAccounts = await endpoint.getSendIXAccountMetaForCPI(
    conn as never,
    admin.publicKey as never,
    path,
    uln,
    "confirmed",
  );
  const sendAccounts = rawSendAccounts.map((a: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }) => ({
    pubkey: new PublicKey(a.pubkey.toBase58()),
    isSigner: a.isSigner,
    isWritable: a.isWritable,
  }));

  const nativeFee = BigInt(process.env.NATIVE_FEE ?? "3000000");
  console.log("native_fee:", nativeFee.toString(), "lamports");

  const data = Buffer.from(
    encodeSubmitIntentData({
      blobId: BLOB_ID as `0x${string}`,
      size: SIZE,
      encodingType: ENCODING_TYPE,
      storageEpochs: STORAGE_EPOCHS,
      deadline,
      dstEid: SUI_TESTNET_EID,
      options: new Uint8Array(options),
      nativeFee,
    }),
  );

  const ix = new TransactionInstruction({
    programId: BOSPHOR_PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: noncePdaKey, isSigner: false, isWritable: true },
      { pubkey: intent, isSigner: false, isWritable: true },
      { pubkey: store, isSigner: false, isWritable: false },
      { pubkey: peer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...sendAccounts,
    ],
    data,
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(ix);

  const sig = await sendAndConfirmTransaction(conn, tx, [admin], { commitment: "confirmed" });
  console.log("\nsubmit_intent confirmed:", sig);

  const parsed = await conn.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const emitted = findIntentSubmittedIntentId(parsed?.meta?.logMessages ?? []);
  console.log("emitted intentId:", emitted);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
