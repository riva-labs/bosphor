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
// Env file is parameterizable so testnet deploys never read or overwrite the
// live root .env (which holds mainnet config). Defaults to root .env.
const ENV_PATH = process.env.BOSPHOR_ENV_FILE
  ? resolve(process.env.BOSPHOR_ENV_FILE)
  : resolve(import.meta.dirname, "../../.env");
config({ path: ENV_PATH });

import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { createSuiClient, createSuiSigner, signAndExecute, getWorkerCapAddress } from "../util/sui-client.js";

// --- LZ Infrastructure (from .env) ---
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
const LZ_DVN_SUI = process.env.SUI_LZ_DVN_PKG!;
const LZ_EXECUTOR_OBJ = process.env.SUI_LZ_EXECUTOR_OBJ!;
const CLOCK = "0x6";

const EVM_EID = Number(process.env.EVM_EID) || 40161;

// --- Config from env ---
const SUI_GRPC_URL = process.env.SUI_GRPC_URL || "https://sui-testnet.mystenlabs.com";
const SUI_DEPLOYER_KEY = process.env.SUI_DEPLOYER_KEY;
const EVM_ADAPTER_ADDRESS = process.env.EVM_ADAPTER_ADDRESS;

const requiredEnv = ["SUI_DEPLOYER_KEY", "SUI_LZ_ENDPOINT_V2_OBJ", "SUI_LZ_OAPP_PKG", "SUI_LZ_ULN302", "SUI_LZ_ULN302_OBJ", "SUI_LZ_DVN_PKG", "SUI_LZ_EXECUTOR_PKG", "SUI_LZ_EXECUTOR_OBJ", "SUI_LZ_BYTES32_PKG"];
for (const k of requiredEnv) {
  if (!process.env[k]) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

const suiClient = createSuiClient(SUI_GRPC_URL);
const keypair = createSuiSigner(SUI_DEPLOYER_KEY!);
const deployerAddress = keypair.toSuiAddress();

// --- Helpers ---
function updateEnv(updates: Record<string, string>) {
  const envPath = ENV_PATH;
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

async function exec(tx: Transaction, label: string): Promise<any> {
  const result: any = await signAndExecute(suiClient, tx, keypair);
  const digest = result.digest;
  const ok = result.effects?.status?.success ?? result.status?.success;
  if (!ok) {
    console.error(`[FAIL] ${label}:`, result.effects?.status ?? result.status);
    throw new Error(`${label} failed`);
  }
  console.log(`[OK] ${label}: ${digest}`);
  // Wait for transaction finality to avoid object version conflicts
  await waitTx(digest);
  return result;
}

// Testnet gRPC intermittently aborts the wait with a timeout even though the
// transaction is already on-chain. Retry before giving up so a slow indexer
// does not abort a multi-step deploy.
async function waitTx(digest: string) {
  // Prefer waiting on the SAME gRPC node used to build transactions, so the
  // next tx's gas/object versions resolve consistently (read-after-write). The
  // v2 gRPC waitForTransaction works; fall back to JSON-RPC polling if it hangs.
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return await Promise.race([
        suiClient.core.waitForTransaction({ digest }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("grpc wait timeout")), 15000),
        ),
      ]);
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const rpcs = [
    process.env.SUI_JSONRPC_URL,
    "https://sui-testnet-rpc.publicnode.com",
    "https://rpc-testnet.suiscan.xyz",
  ].filter(Boolean) as string[];
  for (let attempt = 1; attempt <= 60; attempt++) {
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sui_getTransactionBlock",
            params: [digest, { showEffects: true }],
          }),
          signal: AbortSignal.timeout(8000),
        });
        const j: any = await res.json();
        if (j?.result?.digest === digest) return j.result;
      } catch {
        /* try next rpc / next attempt */
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`waitTx: ${digest} not indexed after polling`);
}

// Look up a created object of a given type from a tx's objectChanges via
// JSON-RPC (the gRPC response shape for created objects is version-dependent).
async function findCreatedByType(digest: string, typeSubstr: string): Promise<string> {
  const rpcs = [
    process.env.SUI_JSONRPC_URL,
    "https://sui-testnet-rpc.publicnode.com",
    "https://rpc-testnet.suiscan.xyz",
  ].filter(Boolean) as string[];
  for (let attempt = 1; attempt <= 20; attempt++) {
    for (const rpc of rpcs) {
      try {
        const res = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "sui_getTransactionBlock",
            params: [digest, { showObjectChanges: true }],
          }),
          signal: AbortSignal.timeout(8000),
        });
        const j: any = await res.json();
        const changes = j?.result?.objectChanges;
        if (Array.isArray(changes)) {
          const hit = changes.find(
            (c: any) => c.type === "created" && (c.objectType || "").includes(typeSubstr),
          );
          return hit?.objectId ?? "";
        }
      } catch {
        /* try next */
      }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return "";
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
  // Use LayerZero's endpoint-default DVN set instead of pinning a specific DVN.
  // The default resolves to LZ Labs' active DVN, which self-heals across their
  // DVN rotations/outages without us hardcoding a (possibly deprecated) address.
  const useDefaultDvns = (process.env.LZ_USE_DEFAULT_DVNS ?? "false") === "true";
  return OAppUlnConfig.serialize({
    use_default_confirmations: useDefaultDvns,
    use_default_required_dvns: useDefaultDvns,
    use_default_optional_dvns: true,
    uln_config: useDefaultDvns
      ? { confirmations: 0n, required_dvns: [], optional_dvns: [], optional_dvn_threshold: 0 }
      : { confirmations, required_dvns: requiredDvns, optional_dvns: [], optional_dvn_threshold: 0 },
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
  // Detect network from SUI_RPC_URL and switch sui client env
  const isMainnet = SUI_GRPC_URL.includes("mainnet");
  if (isMainnet) {
    try { execSync("sui client switch --env mainnet", { encoding: "utf-8", stdio: "pipe" }); } catch {}
    console.log("  Switched sui client to mainnet");
  }
  const suiLzPath = resolve(import.meta.dirname, "../../contracts/sui/lz-receiver");

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
  await waitTx(result.digest);

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

  const result: any = await exec(tx, "register_oapp");

  // Find the created MessagingChannel. v2 gRPC core exposes effects.changedObjects
  // plus an objectTypes map; fall back to an objectChanges array shape.
  let messagingChannelId = "";
  const objectTypes: Record<string, string> = result.objectTypes ?? {};
  for (const obj of result.effects?.changedObjects ?? []) {
    const t = objectTypes[obj.id] || obj.objectType || "";
    if (t.includes("::messaging_channel::MessagingChannel")) messagingChannelId = obj.id;
  }
  if (!messagingChannelId) {
    for (const c of result.objectChanges ?? []) {
      if ((c.objectType || "").includes("::messaging_channel::MessagingChannel")) {
        messagingChannelId = c.objectId;
      }
    }
  }
  if (!messagingChannelId) {
    // gRPC response shapes vary; fall back to a JSON-RPC lookup of the tx's
    // created objects.
    messagingChannelId = await findCreatedByType(
      result.digest,
      "::messaging_channel::MessagingChannel",
    );
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

  // Executor config (type 1).
  //
  // The ULN records this address as the callee of the executor child call,
  // and the executor worker authenticates with its CallCap identity (its
  // original package address), never its latest package id. Pinning the
  // package id here is exactly the misconfig that made every lz_send_proof
  // abort in call::new_child_batch with code 10 (issue #337). In default
  // mode we write zeros so the config inherits the ULN default executor and
  // self-heals across LZ executor rotations; otherwise we resolve the cap
  // identity from the live executor object.
  const tx3 = new Transaction();
  const useDefaultExecutor = (process.env.LZ_USE_DEFAULT_DVNS ?? "false") === "true";
  const execConfig = useDefaultExecutor
    ? encodeExecutorConfig(0n, "0x" + "0".repeat(64))
    : encodeExecutorConfig(10000n, await getWorkerCapAddress(suiClient, LZ_EXECUTOR_OBJ));
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
    target: `${process.env.SUI_LZ_BYTES32_PKG}::bytes32::from_bytes`,
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

// --- Step 6: Authorize the operational relayer ---
async function setRelayer(packageId: string, configId: string, oappId: string, adminCapId: string) {
  // LzReceiverConfig.relayer initializes to ctx.sender() at publish (the
  // deployer). lz_send_proof asserts ctx.sender() == config.relayer, so a
  // deploy that skips this step makes every relayer-signed proof send abort
  // with code 2 (EUnauthorizedRelayer). Authorize the address SUI_RELAYER_KEY
  // derives; without it the config keeps rejecting the operational relayer.
  const relayerKey = process.env.SUI_RELAYER_KEY;
  if (!relayerKey) {
    console.log("\n=== Step 6: set_relayer SKIPPED (SUI_RELAYER_KEY not set) ===");
    console.warn("  WARNING: LzReceiverConfig.relayer stays at the deployer address.");
    console.warn("  The relayer's lz_send_proof will abort with EUnauthorizedRelayer (code 2).");
    console.warn("  Repair with: npx tsx scripts/util/set-lz-relayer.ts --use-relayer-key");
    return;
  }
  const relayerAddress = createSuiSigner(relayerKey).toSuiAddress();
  if (relayerAddress === deployerAddress) {
    console.log("\n=== Step 6: set_relayer SKIPPED (relayer key == deployer key) ===");
    return;
  }
  console.log(`\n=== Step 6: set_relayer (${relayerAddress}) ===`);
  const tx = new Transaction();
  tx.moveCall({
    target: `${packageId}::lz_receiver::set_relayer`,
    arguments: [
      tx.object(configId), tx.object(adminCapId), tx.object(oappId),
      tx.pure.address(relayerAddress),
    ],
  });
  await exec(tx, "set_relayer");
}

// --- Main ---
async function main() {
  console.log("=== Bosphor Sui Deployment ===");
  console.log(`  Deployer: ${deployerAddress}`);
  console.log(`  Network:  ${SUI_GRPC_URL}`);

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

  // Step 6: Authorize the operational relayer for lz_send_proof
  await setRelayer(packageId, configId, oappId, adminCapId);

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
