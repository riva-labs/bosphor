/**
 * skip-nonce1.ts
 *
 * Skips nonce 1 which was sent with a bad 1-DVN config and never verified.
 * This unblocks nonces 2-4 which are all verified and waiting for delivery.
 */
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

const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const ADMIN_CAP = process.env.SUI_LZ_ADMIN_CAP_ID!;
const ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const CHANNEL_ID = "0x014118af1e0f7aa7117e5bdec853524e7f6cbee25fbfbe95a92979a0e4561281";
const BYTES32_PKG = process.env.SUI_LZ_BYTES32_PKG!;

const SRC_EID = 30101;
const SENDER_HEX = "0000000000000000000000003c8b7a1c684dd10aed6bb392651c678f1ce05e10";

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.substring(i, i + 2), 16));
  }
  return bytes;
}

async function main() {
  console.log("=== Skip Nonce 1 ===");
  console.log("  Reason: nonce 1 was sent with 1-DVN config, DVN never verified.");
  console.log("  This unblocks nonces 2-4 which are verified and waiting.");
  console.log();

  const senderBytes = hexToBytes(SENDER_HEX);

  const tx = new Transaction();

  // Build Bytes32 from raw bytes in the PTB
  const [senderBytes32] = tx.moveCall({
    target: `${BYTES32_PKG}::bytes32::from_bytes`,
    arguments: [tx.pure("vector<u8>", senderBytes)],
  });

  tx.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::skip`,
    arguments: [
      tx.object(OAPP_ID),          // &OApp
      tx.object(ADMIN_CAP),         // &AdminCap
      tx.object(ENDPOINT_OBJ),      // &EndpointV2
      tx.object(CHANNEL_ID),        // &mut MessagingChannel
      tx.pure.u32(SRC_EID),         // src_eid
      senderBytes32,                 // sender: Bytes32
      tx.pure.u64(1),               // nonce to skip
    ],
  });

  // Dry-run first
  console.log("Dry-running...");
  const dryRun = await suiClient.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: keypair.toSuiAddress(),
  });
  const status = dryRun.effects?.status?.status;
  const error = dryRun.effects?.status?.error;
  console.log(`  Dry-run: ${status}`);
  if (error) {
    console.log(`  Error: ${error}`);
    return;
  }

  // Execute
  console.log("Executing...");
  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  console.log(`  TX: ${result.digest}`);
  console.log(`  Status: ${result.effects?.status?.status}`);
  if (result.effects?.status?.error) {
    console.log(`  Error: ${result.effects.status.error}`);
  }
  for (const e of (result.events || [])) {
    const name = e.type?.split("::").pop();
    console.log(`  Event: ${name}`);
  }
}

main().catch((err) => { console.error("Fatal:", err.message || err); process.exit(1); });
