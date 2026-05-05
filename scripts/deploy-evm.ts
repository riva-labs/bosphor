/**
 * deploy-evm.ts
 *
 * Builds and deploys the BosphorAdapter contract to Sepolia, then
 * configures setPeer for the Sui LZ OApp if SUI_LZ_PACKAGE_ID is set.
 * Updates .env with the deployed EVM_ADAPTER_ADDRESS.
 *
 * Usage: npm run deploy:evm
 * Required env: EVM_RPC_URL, EVM_RELAYER_KEY
 * Optional env: SUI_LZ_PACKAGE_ID (for automatic peer setup)
 */
import { config } from "dotenv";
import { resolve } from "path";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
config({ path: resolve(import.meta.dirname, "../.env") });

import { ethers } from "ethers";

// --- Config ---
const EVM_RPC_URL = process.env.EVM_RPC_URL;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY;
const SUI_LZ_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID;

if (!EVM_RPC_URL || !EVM_RELAYER_KEY) {
  console.error("Missing EVM_RPC_URL or EVM_RELAYER_KEY in .env");
  process.exit(1);
}

const LZ_ENDPOINT_SEPOLIA = "0x6EDCE65403992e310A62460808c4b910D972f10f";
const SUI_EID = 40378;

const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
const wallet = new ethers.Wallet(EVM_RELAYER_KEY, provider);

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

async function main() {
  const deployer = wallet.address;
  console.log("=== Bosphor EVM Deployment ===");
  console.log(`  Deployer: ${deployer}`);
  console.log(`  RPC:      ${EVM_RPC_URL}`);
  console.log(`  Endpoint: ${LZ_ENDPOINT_SEPOLIA}`);

  // Step 1: Build contracts
  console.log("\n=== Step 1: Build contracts ===");
  const contractsDir = resolve(import.meta.dirname, "../contracts");
  try {
    execSync("forge build", { cwd: contractsDir, encoding: "utf-8", stdio: "pipe" });
    console.log("[OK] forge build");
  } catch (err: any) {
    // Check if artifact already exists (build may fail due to iCloud eviction but artifact is cached)
    const artifactPath = resolve(contractsDir, "out/BosphorAdapter.sol/BosphorAdapter.json");
    if (existsSync(artifactPath)) {
      console.log("[WARN] forge build failed but artifact exists, continuing...");
    } else {
      console.error("[FAIL] forge build:", err.stderr || err.message);
      process.exit(1);
    }
  }

  // Step 2: Deploy BosphorAdapter
  console.log("\n=== Step 2: Deploy BosphorAdapter ===");
  const artifactPath = resolve(contractsDir, "out/BosphorAdapter.sol/BosphorAdapter.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  const abi = artifact.abi;
  const bytecode = artifact.bytecode.object;

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const contract = await factory.deploy(LZ_ENDPOINT_SEPOLIA, deployer, deployer);
  await contract.waitForDeployment();
  const adapterAddress = await contract.getAddress();

  console.log(`[OK] BosphorAdapter deployed: ${adapterAddress}`);

  // Step 3: setPeer for Sui
  if (SUI_LZ_PACKAGE_ID) {
    console.log(`\n=== Step 3: setPeer(${SUI_EID}, ${SUI_LZ_PACKAGE_ID}) ===`);
    const adapter = new ethers.Contract(adapterAddress, abi, wallet);
    // Sui package ID is 32 bytes, pad to bytes32
    const peerBytes32 = "0x" + SUI_LZ_PACKAGE_ID.replace("0x", "").padStart(64, "0");
    const tx = await adapter.setPeer(SUI_EID, peerBytes32);
    await tx.wait();
    console.log(`[OK] setPeer: ${tx.hash}`);
  } else {
    console.log("\n=== Step 3: SKIPPED (SUI_LZ_PACKAGE_ID not set) ===");
    console.log("  Run 'npm run wire' after deploying Sui to configure peers.");
  }

  // Write to .env
  updateEnv({ EVM_ADAPTER_ADDRESS: adapterAddress });

  console.log("\n=== EVM Deployment Complete ===");
  console.log(`  BosphorAdapter: ${adapterAddress}`);
  console.log("  .env updated.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
