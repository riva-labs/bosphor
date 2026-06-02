/**
 * manual-execute.ts
 *
 * Manually executes lz_receive for a verified nonce, bypassing the LZ executor.
 * Creates a temporary CallCap, calls endpoint_v2::lz_receive, then our lz_receiver::lz_receive.
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

const ENDPOINT_PKG = process.env.SUI_LZ_ENDPOINT_V2!;
const ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const CALL_PKG = "0x28de9e8e087a6347001907fb698fdf8ab0467b342229b74b19264067aebc4ae9";
const BYTES32_PKG = process.env.SUI_LZ_BYTES32_PKG!;
const BOSPHOR_PKG = process.env.SUI_LZ_PACKAGE_ID!;
const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const CONFIG_ID = process.env.SUI_LZ_CONFIG_ID!;
const CHANNEL_ID = "0x014118af1e0f7aa7117e5bdec853524e7f6cbee25fbfbe95a92979a0e4561281";

// Message data for nonce 2 from LZ Scan
const SRC_EID = 30101;
const NONCE = 2;
const SENDER_HEX = "0000000000000000000000003c8b7a1c684dd10aed6bb392651c678f1ce05e10";
const GUID_HEX = "a4457fafe17884912210a41bee906072d8ebb81b47d719c5bf6d1f1ca67a448c";
const PAYLOAD_HEX = "5e3c56586055cad3fc6a7c2705e32dd9db614de3da3cf952483648ffc33227120000000000000000000000009665322fa22589bf1d8612007717647819f3b2900000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000006a1ece7b000000000000000000000000000000000000000000000000000000000000001d626f7370686f722d6d61696e6e65742d31373830333839343335303636000000";

function hexToBytes(hex: string): number[] {
  const clean = hex.replace("0x", "");
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

async function main() {
  console.log("=== Manual LZ Receive Execution ===");
  console.log(`  Nonce: ${NONCE}`);
  console.log(`  GUID: 0x${GUID_HEX}`);
  console.log();

  const senderBytes = hexToBytes(SENDER_HEX);
  const guidBytes = hexToBytes(GUID_HEX);
  const payloadBytes = hexToBytes(PAYLOAD_HEX);

  const tx = new Transaction();

  // Build Bytes32 values from raw bytes
  const [senderB32] = tx.moveCall({
    target: `${BYTES32_PKG}::bytes32::from_bytes`,
    arguments: [tx.pure("vector<u8>", senderBytes)],
  });
  const [guidB32] = tx.moveCall({
    target: `${BYTES32_PKG}::bytes32::from_bytes`,
    arguments: [tx.pure("vector<u8>", guidBytes)],
  });

  // Step 1: Create temporary CallCap for "executor" role
  const [tempCallCap] = tx.moveCall({
    target: `${CALL_PKG}::call_cap::new_individual_cap`,
  });

  // Step 2: Call endpoint_v2::lz_receive to create the Call hot-potato
  // Option<Coin<SUI>> = none - we use a BCS-encoded Option::None
  const [call] = tx.moveCall({
    target: `${ENDPOINT_PKG}::endpoint_v2::lz_receive`,
    arguments: [
      tx.object(ENDPOINT_OBJ),           // &EndpointV2
      tempCallCap,                         // &CallCap (executor)
      tx.object(CHANNEL_ID),              // &mut MessagingChannel
      tx.pure.u32(SRC_EID),              // src_eid
      senderB32,                           // sender: Bytes32
      tx.pure.u64(NONCE),                // nonce
      guidB32,                             // guid: Bytes32
      tx.pure("vector<u8>", payloadBytes), // message
      tx.pure("vector<u8>", []),          // extra_data
      tx.moveCall({                        // value: Option<Coin<SUI>> = none
        target: "0x1::option::none",
        typeArguments: ["0x2::coin::Coin<0x2::sui::SUI>"],
      })[0],
    ],
  });

  // Step 3: Call our lz_receiver::lz_receive to consume the Call
  tx.moveCall({
    target: `${BOSPHOR_PKG}::lz_receiver::lz_receive`,
    arguments: [
      tx.object(CONFIG_ID),               // &mut LzReceiverConfig
      tx.object(OAPP_ID),                 // &OApp
      call,                                // Call<LzReceiveParam, Void>
    ],
  });

  // Step 4: Transfer the temp CallCap (has Key+Store, no Drop)
  tx.transferObjects([tempCallCap], keypair.toSuiAddress());

  // First dry-run
  console.log("Dry-running...");
  try {
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
  } catch (err: any) {
    console.error("Dry-run error:", err.message?.slice(0, 500));
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
    console.log(`  Event: ${name} = ${JSON.stringify(e.parsedJson).slice(0, 200)}`);
  }
}

main().catch((err) => { console.error("Fatal:", err.message || err); process.exit(1); });
