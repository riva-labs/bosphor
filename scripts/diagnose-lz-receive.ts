/**
 * diagnose-lz-receive.ts
 *
 * Diagnostic script to check LZ endpoint state for a stuck message.
 * Queries view functions to determine why the executor isn't delivering.
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

const LZ_ENDPOINT_PKG = process.env.SUI_LZ_ENDPOINT_V2!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const BYTES32_PKG = process.env.SUI_LZ_BYTES32_PKG!;
const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID!;
const CONFIG_ID = process.env.SUI_LZ_CONFIG_ID!;
const MESSAGING_CHANNEL = process.env.SUI_LZ_MESSAGING_CHANNEL!;

// Ethereum mainnet sender (BosphorAdapter)
const EVM_ADAPTER = "0x3c8B7A1c684dD10aEd6Bb392651c678f1CE05E10";
const SRC_EID = 30101; // Ethereum mainnet

function addressToBytes32(addr: string): number[] {
  const clean = addr.replace("0x", "").toLowerCase().padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

async function devInspect(tx: Transaction, label: string) {
  try {
    const result = await suiClient.devInspectTransactionBlock({
      transactionBlock: tx,
      sender: keypair.toSuiAddress(),
    });
    if (result.effects?.status?.status !== "success") {
      console.log(`  [FAIL] ${label}:`, result.effects?.status);
      return null;
    }
    return result;
  } catch (err: any) {
    console.log(`  [ERROR] ${label}:`, err.message?.slice(0, 200));
    return null;
  }
}

async function main() {
  console.log("=== LZ Endpoint Diagnostic ===");
  console.log(`  Endpoint: ${LZ_ENDPOINT_OBJ}`);
  console.log(`  OApp:     ${OAPP_ID}`);
  console.log(`  Package:  ${PACKAGE_ID}`);
  console.log(`  Src EID:  ${SRC_EID}`);
  console.log(`  Sender:   ${EVM_ADAPTER}`);
  console.log();

  // 1. Check if OApp is registered (by OBJECT ID)
  console.log("--- 1a. OApp Registration (Object ID) ---");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${LZ_ENDPOINT_PKG}::endpoint_v2::is_oapp_registered`,
      arguments: [
        tx.object(LZ_ENDPOINT_OBJ),
        tx.pure.address(OAPP_ID),
      ],
    });
    const result = await devInspect(tx, "is_oapp_registered(object)");
    if (result?.results?.[0]?.returnValues) {
      const bytes = result.results[0].returnValues[0][0];
      const registered = bytes[0] === 1;
      console.log(`  Registered (object ${OAPP_ID}): ${registered}`);
    }
  }

  // 1b. Check if OApp is registered (by PACKAGE ID)
  console.log("\n--- 1b. OApp Registration (Package ID) ---");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${LZ_ENDPOINT_PKG}::endpoint_v2::is_oapp_registered`,
      arguments: [
        tx.object(LZ_ENDPOINT_OBJ),
        tx.pure.address(PACKAGE_ID),
      ],
    });
    const result = await devInspect(tx, "is_oapp_registered(package)");
    if (result?.results?.[0]?.returnValues) {
      const bytes = result.results[0].returnValues[0][0];
      const registered = bytes[0] === 1;
      console.log(`  Registered (package ${PACKAGE_ID}): ${registered}`);
    }
  }

  // 2a. Get OApp info (by OBJECT ID)
  console.log("\n--- 2a. OApp Info (Object ID) ---");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${LZ_ENDPOINT_PKG}::endpoint_v2::get_oapp_info`,
      arguments: [
        tx.object(LZ_ENDPOINT_OBJ),
        tx.pure.address(OAPP_ID),
      ],
    });
    const result = await devInspect(tx, "get_oapp_info(object)");
    if (result?.results?.[0]?.returnValues) {
      const bytes = result.results[0].returnValues[0][0];
      console.log(`  OApp info bytes length: ${bytes.length}`);
      console.log(`  Raw (first 100 bytes): ${Array.from(bytes.slice(0, 100)).map((b: number) => b.toString(16).padStart(2, '0')).join('')}`);
    }
  }

  // 2b. Get OApp info (by PACKAGE ID)
  console.log("\n--- 2b. OApp Info (Package ID) ---");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${LZ_ENDPOINT_PKG}::endpoint_v2::get_oapp_info`,
      arguments: [
        tx.object(LZ_ENDPOINT_OBJ),
        tx.pure.address(PACKAGE_ID),
      ],
    });
    const result = await devInspect(tx, "get_oapp_info(package)");
    if (result?.results?.[0]?.returnValues) {
      const bytes = result.results[0].returnValues[0][0];
      console.log(`  OApp info bytes length: ${bytes.length}`);
      console.log(`  Raw (first 100 bytes): ${Array.from(bytes.slice(0, 100)).map((b: number) => b.toString(16).padStart(2, '0')).join('')}`);
    }
  }

  // 3-9: Bytes32-based queries via BCS pure encoding
  // Bytes32 struct = { bytes: vector<u8> }
  // BCS encoding: ULEB128(32) + 32 raw bytes
  console.log("\n--- 3. Channel & Nonce State (via BCS) ---");
  {
    const senderBytes = addressToBytes32(EVM_ADAPTER);
    // BCS encode Bytes32: struct { bytes: vector<u8>(32) }
    // vector<u8> BCS = ULEB128 length (0x20 = 32) + 32 bytes
    const bcsBytes32 = new Uint8Array([0x20, ...senderBytes]);

    const queries = [
      { name: "is_channel_inited", fn: "is_channel_inited", extra: [] as number[] },
      { name: "get_inbound_nonce", fn: "get_inbound_nonce", extra: [] as number[] },
      { name: "get_lazy_inbound_nonce", fn: "get_lazy_inbound_nonce", extra: [] as number[] },
    ];

    for (const q of queries) {
      const tx = new Transaction();
      const args: any[] = [
        tx.object(MESSAGING_CHANNEL),
        tx.pure.u32(SRC_EID),
        tx.pure(bcsBytes32),
      ];
      tx.moveCall({
        target: `${LZ_ENDPOINT_PKG}::endpoint_v2::${q.fn}`,
        arguments: args,
      });
      const result = await devInspect(tx, q.name);
      if (result?.results?.[0]?.returnValues?.[0]) {
        const bytes = result.results[0].returnValues[0][0];
        if (q.fn.includes("nonce")) {
          const nonce = Number(BigInt(bytes[0]) | (BigInt(bytes[1]) << 8n) | (BigInt(bytes[2]) << 16n) | (BigInt(bytes[3]) << 24n));
          console.log(`  ${q.name}: ${nonce}`);
        } else {
          console.log(`  ${q.name}: ${bytes[0] === 1}`);
        }
      }
    }

    // Payload hash and verifiable queries (extra u64 arg)
    const nonceQueries = [
      { name: "has_payload_hash(n=1)", fn: "has_inbound_payload_hash", nonce: 1 },
      { name: "has_payload_hash(n=2)", fn: "has_inbound_payload_hash", nonce: 2 },
      { name: "verifiable(n=2)", fn: "verifiable", nonce: 2 },
    ];

    for (const q of nonceQueries) {
      const tx = new Transaction();
      tx.moveCall({
        target: `${LZ_ENDPOINT_PKG}::endpoint_v2::${q.fn}`,
        arguments: [
          tx.object(MESSAGING_CHANNEL),
          tx.pure.u32(SRC_EID),
          tx.pure(bcsBytes32),
          tx.pure.u64(q.nonce),
        ],
      });
      const result = await devInspect(tx, q.name);
      if (result?.results?.[0]?.returnValues?.[0]) {
        const bytes = result.results[0].returnValues[0][0];
        console.log(`  ${q.name}: ${bytes[0] === 1}`);
      }
    }
  }

  // 10. Try to dry-run build_lz_receive_ptb (simulate what executor does)
  console.log("\n--- 10. Dry-run build_lz_receive_ptb ---");
  {
    const tx = new Transaction();
    // The executor would call ptb_builder::build_lz_receive_ptb
    // but it needs a Call<LzReceiveParam, Void> object, which is only
    // created during endpoint::clear/lz_receive. So we can't call this
    // directly. Instead, check if the package is accessible.
    tx.moveCall({
      target: `${PACKAGE_ID}::ptb_builder::lz_receive_info`,
      arguments: [
        tx.object(CONFIG_ID),
        tx.object(OAPP_ID),
      ],
    });
    const result = await devInspect(tx, "lz_receive_info (dry-run)");
    if (result?.results?.[0]?.returnValues) {
      const bytes = result.results[0].returnValues[0][0];
      console.log(`  lz_receive_info output length: ${bytes.length} bytes`);
      console.log(`  First 40 bytes: ${Array.from(bytes.slice(0, 40)).map((b: number) => b.toString(16).padStart(2, '0')).join('')}`);
    }
  }

  // 11. Check receive library for our OApp
  console.log("\n--- 11. Receive Library ---");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${LZ_ENDPOINT_PKG}::endpoint_v2::get_receive_library`,
      arguments: [
        tx.object(LZ_ENDPOINT_OBJ),
        tx.pure.address(OAPP_ID),
        tx.pure.u32(SRC_EID),
      ],
    });
    const result = await devInspect(tx, "get_receive_library");
    if (result?.results?.[0]?.returnValues) {
      const bytes = result.results[0].returnValues[0][0];
      const addr = "0x" + Array.from(bytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');
      console.log(`  Receive library: ${addr}`);
    }
  }

  // 12. Check send library for our OApp
  console.log("\n--- 12. Send Library ---");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${LZ_ENDPOINT_PKG}::endpoint_v2::get_send_library`,
      arguments: [
        tx.object(LZ_ENDPOINT_OBJ),
        tx.pure.address(OAPP_ID),
        tx.pure.u32(SRC_EID),
      ],
    });
    const result = await devInspect(tx, "get_send_library");
    if (result?.results?.[0]?.returnValues) {
      const bytes = result.results[0].returnValues[0][0];
      const addr = "0x" + Array.from(bytes).map((b: number) => b.toString(16).padStart(2, '0')).join('');
      console.log(`  Send library: ${addr}`);
    }
  }

  console.log("\n=== Diagnostic Complete ===");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
