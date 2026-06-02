import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

const suiClient = new SuiClient({ url: process.env.SUI_RPC_URL! });
const { secretKey } = decodeSuiPrivateKey(process.env.SUI_DEPLOYER_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const deployerAddr = keypair.toSuiAddress();

const LZ_PKG = process.env.SUI_LZ_PACKAGE_ID!;
const CONFIG_ID = process.env.SUI_LZ_CONFIG_ID!;
const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const LZ_ENDPOINT = process.env.SUI_LZ_ENDPOINT_V2!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
const EXECUTOR_PKG = "0xde7fe1a6648d587fcc991f124f3aa5b6389340610804108094d5c5fbf61d1989";
const EXECUTOR_OBJ = process.env.SUI_LZ_EXECUTOR_OBJ!;
const EXEC_FEE_LIB = process.env.SUI_LZ_EXEC_FEE_LIB!;
const EXEC_FEE_LIB_OBJ = process.env.SUI_LZ_EXEC_FEE_LIB_OBJ!;
const DVN_PKG = process.env.SUI_LZ_DVN_PKG!;
const DVN_OBJ = process.env.SUI_LZ_DVN_OBJ!;
const DVN_FEE_LIB = process.env.SUI_LZ_DVN_FEE_LIB!;
const DVN_FEE_LIB_OBJ = process.env.SUI_LZ_DVN_FEE_LIB_OBJ!;
const PRICE_FEED = process.env.SUI_LZ_PRICE_FEED!;
const PRICE_FEED_OBJ = process.env.SUI_LZ_PRICE_FEED_OBJ!;
const TREASURY = process.env.SUI_LZ_TREASURY!;
const TREASURY_OBJ = process.env.SUI_LZ_TREASURY_OBJ!;
const MESSAGING_CHANNEL = process.env.SUI_LZ_MESSAGING_CHANNEL!;

const EVM_DST_EID = 30101; // Ethereum mainnet

// Fake intent data for test
const testIntentId = "0x" + "ab".repeat(32);
const testBlobId = "0x" + "cd".repeat(32);
const testEndEpoch = 50;

async function main() {
  console.log("=== Test: Sui -> Ethereum LZ Send ===");
  console.log(`  Deployer: ${deployerAddr}`);
  console.log(`  DST EID:  ${EVM_DST_EID} (Ethereum mainnet)`);
  console.log(`  LZ Pkg:   ${LZ_PKG}`);

  // First quote the fee
  console.log("\nQuoting LZ fee...");
  const quoteTx = new Transaction();

  // Build the proof message
  const [proofMsg] = quoteTx.moveCall({
    target: `${LZ_PKG}::lz_receiver::build_proof_message`,
    arguments: [
      quoteTx.pure("vector<u8>", Array.from(Buffer.from(testIntentId.slice(2), "hex"))),
      quoteTx.pure("vector<u8>", Array.from(Buffer.from(testBlobId.slice(2), "hex"))),
      quoteTx.pure.u64(testEndEpoch),
    ],
  });

  // Get lz_receive_info for the quote
  const [info] = quoteTx.moveCall({
    target: `${LZ_PKG}::ptb_builder::lz_receive_info`,
    arguments: [quoteTx.object(CONFIG_ID), quoteTx.object(OAPP_ID)],
  });

  // Quote
  const [quotedFee] = quoteTx.moveCall({
    target: `${LZ_PKG}::ptb_builder::quote`,
    arguments: [
      quoteTx.object(CONFIG_ID),
      quoteTx.object(OAPP_ID),
      quoteTx.pure.u32(EVM_DST_EID),
      proofMsg,
      quoteTx.pure("vector<u8>", []),  // options
      quoteTx.pure.bool(false),  // pay in LZ token
      // LZ infra objects
      quoteTx.object(LZ_ENDPOINT_OBJ),
      quoteTx.object(ULN302_OBJ),
      quoteTx.object(EXECUTOR_OBJ),
      quoteTx.object(EXEC_FEE_LIB_OBJ),
      quoteTx.object(DVN_OBJ),
      quoteTx.object(DVN_FEE_LIB_OBJ),
      quoteTx.object(PRICE_FEED_OBJ),
      quoteTx.object(TREASURY_OBJ),
      info,
    ],
  });

  const quoteResult = await suiClient.devInspectTransactionBlock({
    transactionBlock: quoteTx,
    sender: deployerAddr,
  });

  if (quoteResult.effects?.status?.status !== "success") {
    console.error("Quote failed:", quoteResult.effects?.status);
    // Try to extract more info
    console.error("Results:", JSON.stringify(quoteResult.results, null, 2));
    process.exit(1);
  }

  // Parse fee from results
  const feeBytes = quoteResult.results?.[2]?.returnValues?.[0]?.[0];
  let feeAmount = 500_000_000n; // default 0.5 SUI
  if (feeBytes) {
    const buf = Buffer.from(feeBytes as number[]);
    feeAmount = buf.readBigUInt64LE(0);
    console.log(`  Quoted fee: ${feeAmount} MIST (${Number(feeAmount) / 1e9} SUI)`);
  } else {
    console.log(`  Using default fee: ${feeAmount} MIST`);
  }

  // Add 10% buffer
  feeAmount = (feeAmount * 11n) / 10n;
  console.log(`  With buffer: ${feeAmount} MIST`);

  // Now send
  console.log("\nSending LZ proof...");
  const tx = new Transaction();

  const [msg] = tx.moveCall({
    target: `${LZ_PKG}::lz_receiver::build_proof_message`,
    arguments: [
      tx.pure("vector<u8>", Array.from(Buffer.from(testIntentId.slice(2), "hex"))),
      tx.pure("vector<u8>", Array.from(Buffer.from(testBlobId.slice(2), "hex"))),
      tx.pure.u64(testEndEpoch),
    ],
  });

  const [sendInfo] = tx.moveCall({
    target: `${LZ_PKG}::ptb_builder::lz_receive_info`,
    arguments: [tx.object(CONFIG_ID), tx.object(OAPP_ID)],
  });

  const [feeCoin] = tx.splitCoins(tx.gas, [tx.pure.u64(feeAmount)]);

  tx.moveCall({
    target: `${LZ_PKG}::ptb_builder::send`,
    arguments: [
      tx.object(CONFIG_ID),
      tx.object(OAPP_ID),
      tx.pure.u32(EVM_DST_EID),
      msg,
      tx.pure("vector<u8>", []),  // options
      feeCoin,
      // LZ infra
      tx.object(LZ_ENDPOINT_OBJ),
      tx.object(MESSAGING_CHANNEL),
      tx.object(ULN302_OBJ),
      tx.object(EXECUTOR_OBJ),
      tx.object(EXEC_FEE_LIB_OBJ),
      tx.object(DVN_OBJ),
      tx.object(DVN_FEE_LIB_OBJ),
      tx.object(PRICE_FEED_OBJ),
      tx.object(TREASURY_OBJ),
      tx.object("0x6"), // clock
      sendInfo,
    ],
  });

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });

  if (result.effects?.status?.status !== "success") {
    console.error("SEND FAILED:", result.effects?.status);
    process.exit(1);
  }

  console.log(`\n[OK] LZ proof sent: ${result.digest}`);
  console.log(`  Suiscan:  https://suiscan.xyz/mainnet/tx/${result.digest}`);
  console.log(`  LZ Scan:  https://layerzeroscan.com/tx/${result.digest}`);

  // Show events
  if (result.events?.length) {
    console.log(`\nEvents (${result.events.length}):`);
    for (const ev of result.events) {
      console.log(`  ${ev.type}`);
    }
  }
}

main().catch((err) => { console.error("Fatal:", err.message || err); process.exit(1); });
