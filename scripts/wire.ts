/**
 * wire.ts
 *
 * Connects EVM and Sui deployments by setting peers on both sides.
 * EVM setPeer uses the Sui PACKAGE ID (not OApp object ID).
 * Run after both deploy:sui and deploy:evm have completed.
 *
 * Usage: npm run wire
 * Required env: EVM_RPC_URL, EVM_RELAYER_KEY, EVM_ADAPTER_ADDRESS,
 *               SUI_LZ_PACKAGE_ID, SUI_LZ_OAPP_ID, SUI_LZ_ADMIN_CAP_ID,
 *               SUI_LZ_MESSAGING_CHANNEL, SUI_DEPLOYER_KEY
 */
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync } from "fs";
config({ path: resolve(import.meta.dirname, "../.env") });

import { ethers } from "ethers";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// --- LZ constants (from .env) ---
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const BYTES32_PKG = process.env.SUI_LZ_BYTES32_PKG!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const EVM_EID = Number(process.env.EVM_EID) || 40161;
const SUI_EID = Number(process.env.SUI_EID) || 40378;

// --- Config from env ---
const EVM_RPC_URL = process.env.EVM_RPC_URL!;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY!;
const EVM_ADAPTER_ADDRESS = process.env.EVM_ADAPTER_ADDRESS!;
const SUI_LZ_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID!;
const SUI_LZ_OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const SUI_LZ_ADMIN_CAP_ID = process.env.SUI_LZ_ADMIN_CAP_ID!;
const SUI_LZ_MESSAGING_CHANNEL = process.env.SUI_LZ_MESSAGING_CHANNEL!;
const SUI_DEPLOYER_KEY = process.env.SUI_DEPLOYER_KEY!;
const SUI_RPC_URL = process.env.SUI_RPC_URL || "https://fullnode.testnet.sui.io:443";

for (const [k, v] of Object.entries({
  EVM_RPC_URL, EVM_RELAYER_KEY, EVM_ADAPTER_ADDRESS, SUI_LZ_PACKAGE_ID,
  SUI_LZ_OAPP_ID, SUI_LZ_ADMIN_CAP_ID, SUI_LZ_MESSAGING_CHANNEL, SUI_DEPLOYER_KEY,
})) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

// --- EVM ---
const ADAPTER_ABI = [
  "function setPeer(uint32 eid, bytes32 peer) external",
  "function peers(uint32 eid) view returns (bytes32)",
  "function owner() view returns (address)",
];

const evmProvider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
const evmWallet = new ethers.Wallet(EVM_RELAYER_KEY, evmProvider);
const adapter = new ethers.Contract(EVM_ADAPTER_ADDRESS, ADAPTER_ABI, evmWallet);

// --- Sui ---
const suiClient = new SuiClient({ url: SUI_RPC_URL });
const suiKeypair = (() => {
  const { secretKey } = decodeSuiPrivateKey(SUI_DEPLOYER_KEY);
  return Ed25519Keypair.fromSecretKey(secretKey);
})();

function addressToBytes32(addr: string): number[] {
  const clean = addr.replace("0x", "").toLowerCase().padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(clean.substring(i, i + 2), 16));
  return bytes;
}

async function suiExec(tx: Transaction, label: string) {
  const result = await suiClient.signAndExecuteTransaction({
    signer: suiKeypair,
    transaction: tx,
    options: { showEffects: true },
  });
  if (result.effects?.status?.status !== "success") {
    console.error(`[FAIL] ${label}:`, result.effects?.status);
    throw new Error(`${label} failed`);
  }
  console.log(`[OK] ${label}: ${result.digest}`);
  await suiClient.waitForTransaction({ digest: result.digest });
}

async function main() {
  console.log("=== Bosphor Wire ===");
  console.log(`  EVM Adapter:    ${EVM_ADAPTER_ADDRESS}`);
  console.log(`  Sui Package:    ${SUI_LZ_PACKAGE_ID}`);
  console.log(`  Sui OApp:       ${SUI_LZ_OAPP_ID}`);

  // Step 1: EVM setPeer
  console.log(`\n=== Step 1: EVM setPeer(${SUI_EID}, Sui Package) ===`);
  const peerBytes32 = "0x" + SUI_LZ_PACKAGE_ID.replace("0x", "").padStart(64, "0");
  const tx1 = await adapter.setPeer(SUI_EID, peerBytes32);
  await tx1.wait();
  console.log(`[OK] EVM setPeer: ${tx1.hash}`);

  // Verify
  const evmPeer = await adapter.peers(SUI_EID);
  console.log(`  Verified peer: ${evmPeer}`);

  // Step 2: Sui set_peer
  console.log(`\n=== Step 2: Sui set_peer(${EVM_EID}, EVM Adapter) ===`);
  const suiTx1 = new Transaction();
  const [peerB32] = suiTx1.moveCall({
    target: `${BYTES32_PKG}::bytes32::from_bytes`,
    arguments: [suiTx1.pure("vector<u8>", addressToBytes32(EVM_ADAPTER_ADDRESS))],
  });
  suiTx1.moveCall({
    target: `${OAPP_PKG}::oapp::set_peer`,
    arguments: [
      suiTx1.object(SUI_LZ_OAPP_ID), suiTx1.object(SUI_LZ_ADMIN_CAP_ID),
      suiTx1.object(LZ_ENDPOINT_OBJ), suiTx1.object(SUI_LZ_MESSAGING_CHANNEL),
      suiTx1.pure.u32(EVM_EID), peerB32,
    ],
  });
  await suiExec(suiTx1, "sui_set_peer");

  console.log("\n=== Wire Complete ===");
  console.log("  Both sides configured. Ready for E2E test.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
