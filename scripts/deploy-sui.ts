/**
 * deploy-sui.ts
 *
 * Publishes the Bosphor LZ OApp package to Sui testnet, registers it with
 * the LayerZero endpoint (OAppInfoV1 format), configures send/receive
 * libraries, DVN, and executor. If EVM_ADAPTER_ADDRESS is set in .env,
 * also configures set_peer.
 *
 * Usage: npm run deploy:sui
 * Required env: SUI_DEPLOYER_KEY, SUI_RPC_URL
 * Optional env: EVM_ADAPTER_ADDRESS (for automatic peer setup)
 */
import { config } from "dotenv";
import { resolve } from "path";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
config({ path: resolve(import.meta.dirname, "../.env") });

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { bcs } from "@mysten/sui/bcs";

// --- LZ Infrastructure (Sui testnet, fixed) ---
const LZ_ENDPOINT_OBJ = "0x2b96537c30c5fa962a1bfb58a168fc17c17f2546c88e2e9252f21ee7d5eff57a";
const OAPP_PKG = "0x04c440985f5deab2fb7f821b3288d93225a3e637cf22dda476809836f0533751";
const BYTES32_PKG = "0xb168928451914a99ec70aa954e4b7e45e2739fdb5c403f540caf647c01645f30";
const ULN302 = "0xf5d69c7b0922ce0ab4540525fbc66ca25ce9f092c64b032b91e4c5625ea0fb24";
const ULN302_OBJ = "0x69541d4feeb08cdd3b20b3502021a676eea0fca4f47d46e423cdc9686df406ff";
const LZ_DVN_SUI = "0x1356fef0c7325536e289e53cc545219cbfbd1490ed762c8d8efb97efa6cfb856";
const LZ_EXECUTOR_SUI = "0xbd529bbc1e862db38c374435c40bb6399f3fffbc097977dbae4b71cfa975adb1";
const CLOCK = "0x6";

const EVM_EID = 40161; // Sepolia

// --- Config from env ---
const SUI_RPC_URL = process.env.SUI_RPC_URL || "https://fullnode.testnet.sui.io:443";
const SUI_DEPLOYER_KEY = process.env.SUI_DEPLOYER_KEY;
const EVM_ADAPTER_ADDRESS = process.env.EVM_ADAPTER_ADDRESS;

if (!SUI_DEPLOYER_KEY) {
  console.error("Missing SUI_DEPLOYER_KEY in .env");
  process.exit(1);
}

const suiClient = new SuiClient({ url: SUI_RPC_URL });
const keypair = (() => {
  const { secretKey } = decodeSuiPrivateKey(SUI_DEPLOYER_KEY);
  return Ed25519Keypair.fromSecretKey(secretKey);
})();
const deployerAddress = keypair.toSuiAddress();

// --- Helpers ---
function updateEnv(updates: Record<string, string>) {
  const envPath = resolve(import.meta.dirname, "../.env");
  let content = readFileSync(envPath, "utf-8");
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }
  writeFileSync(envPath, content);
}

function addressToBytes32(addr: string): number[] {
  const clean = addr.replace("0x", "").toLowerCase().padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

async function exec(tx: Transaction, label: string) {
  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true, showObjectChanges: true, showEvents: true },
  });
  if (result.effects?.status?.status !== "success") {
    console.error(`[FAIL] ${label}:`, result.effects?.status);
    throw new Error(`${label} failed`);
  }
  console.log(`[OK] ${label}: ${result.digest}`);
  // Wait for transaction finality to avoid object version conflicts
  await suiClient.waitForTransaction({ digest: result.digest });
  return result;
}

// BCS encode OAppUlnConfig
function encodeOAppUlnConfig(confirmations: bigint, requiredDvns: string[]): Uint8Array {
  const UlnConfig = bcs.struct("UlnConfig", {
    confirmations: bcs.u64(),
    required_dvns: bcs.vector(bcs.Address),
    optional_dvns: bcs.vector(bcs.Address),
    optional_dvn_threshold: bcs.u8(),
  });
  const OAppUlnConfig = bcs.struct("OAppUlnConfig", {
    use_default_confirmations: bcs.bool(),
    use_default_required_dvns: bcs.bool(),
    use_default_optional_dvns: bcs.bool(),
    uln_config: UlnConfig,
  });
  return OAppUlnConfig.serialize({
    use_default_confirmations: false,
    use_default_required_dvns: false,
    use_default_optional_dvns: true,
    uln_config: { confirmations, required_dvns: requiredDvns, optional_dvns: [], optional_dvn_threshold: 0 },
  }).toBytes();
}

function encodeExecutorConfig(maxMessageSize: bigint, executor: string): Uint8Array {
  const ExecutorConfig = bcs.struct("ExecutorConfig", {
    max_message_size: bcs.u64(),
    executor: bcs.Address,
  });
  return ExecutorConfig.serialize({ max_message_size: maxMessageSize, executor }).toBytes();
}

// --- Step 1: Publish ---
interface PublishResult {
  packageId: string;
  configId: string;
  oappId: string;
  adminCapId: string;
  upgradeCapId: string;
}

async function publish(): Promise<PublishResult> {
  console.log("\n=== Step 1: Publish bosphor_lz package ===");
  const suiLzPath = resolve(import.meta.dirname, "../sui/lz-receiver");

  // Remove Published.toml if exists (allows fresh publish)
  const publishedToml = resolve(suiLzPath, "Published.toml");
  if (existsSync(publishedToml)) {
    unlinkSync(publishedToml);
    console.log("  Removed existing Published.toml for fresh deploy.");
  }

  const raw = execSync(
    `sui client publish "${suiLzPath}" --gas-budget 500000000 --skip-dependency-verification --json`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );

  // Extract JSON from output (might have warnings before it)
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) throw new Error(`No JSON in publish output:\n${raw.slice(0, 500)}`);
  const result = JSON.parse(raw.slice(jsonStart));

  if (result.effects?.status?.status !== "success") {
    throw new Error(`Publish failed: ${JSON.stringify(result.effects?.status)}`);
  }
  console.log(`[OK] Published: ${result.digest}`);
  // Wait for package to be indexed
  await suiClient.waitForTransaction({ digest: result.digest });

  const changes: any[] = result.objectChanges || [];
  let packageId = "";
  let configId = "";
  let oappId = "";
  let adminCapId = "";
  let upgradeCapId = "";

  for (const c of changes) {
    if (c.type === "published") {
      packageId = c.packageId;
    }
    if (c.type === "created") {
      const t: string = c.objectType || "";
      if (t.includes("::lz_receiver::LzReceiverConfig")) configId = c.objectId;
      else if (t.includes("::oapp::AdminCap")) adminCapId = c.objectId;
      else if (t.includes("::oapp::OApp") && !t.includes("AdminCap")) oappId = c.objectId;
      else if (t.includes("::package::UpgradeCap")) upgradeCapId = c.objectId;
    }
  }

  if (!packageId || !configId || !oappId || !adminCapId) {
    console.error("Created objects:", changes.filter((c: any) => c.type === "created").map((c: any) => `${c.objectType} → ${c.objectId}`));
    throw new Error("Failed to parse all required object IDs from publish");
  }

  console.log(`  Package:    ${packageId}`);
  console.log(`  Config:     ${configId}`);
  console.log(`  OApp:       ${oappId}`);
  console.log(`  AdminCap:   ${adminCapId}`);
  console.log(`  UpgradeCap: ${upgradeCapId}`);

  return { packageId, configId, oappId, adminCapId, upgradeCapId };
}

// --- Step 2: Register OApp ---
async function registerOApp(packageId: string, configId: string, oappId: string): Promise<string> {
  console.log("\n=== Step 2: register_oapp ===");
  const tx = new Transaction();

  const [info] = tx.moveCall({
    target: `${packageId}::ptb_builder::lz_receive_info`,
    arguments: [tx.object(configId), tx.object(oappId)],
  });

  tx.moveCall({
    target: `${packageId}::lz_receiver::register_oapp`,
    arguments: [tx.object(configId), tx.object(oappId), tx.object(LZ_ENDPOINT_OBJ), info],
  });

  const result = await exec(tx, "register_oapp");

  // Find MessagingChannel from created objects
  let messagingChannelId = "";
  for (const c of result.objectChanges || []) {
    if ((c as any).type === "created") {
      const t: string = (c as any).objectType || "";
      if (t.includes("::messaging_channel::MessagingChannel")) {
        messagingChannelId = (c as any).objectId;
      }
    }
  }

  if (!messagingChannelId) {
    console.warn("  Warning: MessagingChannel not found in created objects. Check manually.");
  } else {
    console.log(`  MessagingChannel: ${messagingChannelId}`);
  }

  return messagingChannelId;
}

// --- Step 3: Set LZ Libraries ---
async function setLzLibraries(oappId: string, adminCapId: string) {
  console.log("\n=== Step 3: Set LZ send/receive libraries ===");

  // set_send_library
  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_send_library`,
    arguments: [
      tx1.object(oappId), tx1.object(adminCapId), tx1.object(LZ_ENDPOINT_OBJ),
      tx1.pure.u32(EVM_EID), tx1.pure.address(ULN302),
    ],
  });
  await exec(tx1, "set_send_library");

  // set_receive_library
  const tx2 = new Transaction();
  tx2.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_receive_library`,
    arguments: [
      tx2.object(oappId), tx2.object(adminCapId), tx2.object(LZ_ENDPOINT_OBJ),
      tx2.pure.u32(EVM_EID), tx2.pure.address(ULN302),
      tx2.pure.u64(0), tx2.object(CLOCK),
    ],
  });
  await exec(tx2, "set_receive_library");
}

// --- Step 4: Set LZ DVN + Executor Config ---
async function setLzConfig(oappId: string, adminCapId: string) {
  console.log("\n=== Step 4: Set LZ DVN + executor config ===");

  // Receive ULN config (type 3)
  const tx1 = new Transaction();
  const recvConfig = encodeOAppUlnConfig(2n, [LZ_DVN_SUI]);
  const [call1] = tx1.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx1.object(oappId), tx1.object(adminCapId), tx1.object(LZ_ENDPOINT_OBJ),
      tx1.pure.address(ULN302), tx1.pure.u32(EVM_EID), tx1.pure.u32(3),
      tx1.pure("vector<u8>", Array.from(recvConfig)),
    ],
  });
  tx1.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx1.object(ULN302_OBJ), call1] });
  await exec(tx1, "set_receive_uln_config");

  // Send ULN config (type 2)
  const tx2 = new Transaction();
  const sendConfig = encodeOAppUlnConfig(2n, [LZ_DVN_SUI]);
  const [call2] = tx2.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx2.object(oappId), tx2.object(adminCapId), tx2.object(LZ_ENDPOINT_OBJ),
      tx2.pure.address(ULN302), tx2.pure.u32(EVM_EID), tx2.pure.u32(2),
      tx2.pure("vector<u8>", Array.from(sendConfig)),
    ],
  });
  tx2.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx2.object(ULN302_OBJ), call2] });
  await exec(tx2, "set_send_uln_config");

  // Executor config (type 1)
  const tx3 = new Transaction();
  const execConfig = encodeExecutorConfig(10000n, LZ_EXECUTOR_SUI);
  const [call3] = tx3.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx3.object(oappId), tx3.object(adminCapId), tx3.object(LZ_ENDPOINT_OBJ),
      tx3.pure.address(ULN302), tx3.pure.u32(EVM_EID), tx3.pure.u32(1),
      tx3.pure("vector<u8>", Array.from(execConfig)),
    ],
  });
  tx3.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx3.object(ULN302_OBJ), call3] });
  await exec(tx3, "set_executor_config");
}

// --- Step 5: Set Peer (if EVM address available) ---
async function setPeer(
  oappId: string, adminCapId: string, messagingChannelId: string,
) {
  if (!EVM_ADAPTER_ADDRESS) {
    console.log("\n=== Step 5: SKIPPED (EVM_ADAPTER_ADDRESS not set) ===");
    console.log("  Run 'npm run wire' after deploying EVM to configure peers.");
    return;
  }
  console.log(`\n=== Step 5: set_peer (EVM: ${EVM_ADAPTER_ADDRESS}) ===`);

  const tx1 = new Transaction();
  const [peerBytes32] = tx1.moveCall({
    target: `${BYTES32_PKG}::bytes32::from_bytes`,
    arguments: [tx1.pure("vector<u8>", addressToBytes32(EVM_ADAPTER_ADDRESS))],
  });
  tx1.moveCall({
    target: `${OAPP_PKG}::oapp::set_peer`,
    arguments: [
      tx1.object(oappId), tx1.object(adminCapId), tx1.object(LZ_ENDPOINT_OBJ),
      tx1.object(messagingChannelId), tx1.pure.u32(EVM_EID), peerBytes32,
    ],
  });
  await exec(tx1, "set_peer");
}

// --- Main ---
async function main() {
  console.log("=== Bosphor Sui Deployment ===");
  console.log(`  Deployer: ${deployerAddress}`);
  console.log(`  Network:  ${SUI_RPC_URL}`);

  // Verify active sui address matches deployer key
  try {
    const activeAddr = execSync("sui client active-address", { encoding: "utf-8" }).trim();
    if (activeAddr !== deployerAddress) {
      console.warn(`  WARNING: Active sui address (${activeAddr}) != deployer key (${deployerAddress})`);
      console.warn("  The publish will use the active address. SDK operations use SUI_DEPLOYER_KEY.");
    }
  } catch {
    console.warn("  WARNING: Could not check sui active-address. Ensure sui CLI is configured.");
  }

  // Step 1: Publish
  const { packageId, configId, oappId, adminCapId, upgradeCapId } = await publish();

  // Step 2: Register OApp
  const messagingChannelId = await registerOApp(packageId, configId, oappId);

  // Step 3: Set LZ libraries
  await setLzLibraries(oappId, adminCapId);

  // Step 4: Set DVN + executor config
  await setLzConfig(oappId, adminCapId);

  // Step 5: Set peer (if EVM address available)
  if (messagingChannelId) {
    await setPeer(oappId, adminCapId, messagingChannelId);
  }

  // Write to .env
  const envUpdates: Record<string, string> = {
    SUI_LZ_PACKAGE_ID: packageId,
    SUI_LZ_CONFIG_ID: configId,
    SUI_LZ_OAPP_ID: oappId,
    SUI_LZ_ADMIN_CAP_ID: adminCapId,
  };
  if (messagingChannelId) envUpdates.SUI_LZ_MESSAGING_CHANNEL = messagingChannelId;
  if (upgradeCapId) envUpdates.SUI_LZ_UPGRADE_CAP = upgradeCapId;
  updateEnv(envUpdates);

  console.log("\n=== Sui Deployment Complete ===");
  console.log(`  Package:          ${packageId}`);
  console.log(`  LzReceiverConfig: ${configId}`);
  console.log(`  OApp:             ${oappId}`);
  console.log(`  AdminCap:         ${adminCapId}`);
  console.log(`  UpgradeCap:       ${upgradeCapId}`);
  console.log(`  MessagingChannel: ${messagingChannelId}`);
  console.log("  .env updated with new addresses.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
