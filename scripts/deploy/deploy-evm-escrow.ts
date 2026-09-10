/**
 * deploy-evm-escrow.ts
 *
 * Builds and deploys the M4 BosphorEscrowAdapter (origin-chain escrow) to
 * Sepolia, configures setPeer for the Sui LZ OApp when SUI_LZ_PACKAGE_ID is set,
 * and optionally wires Permit2 for the opt-in USDC path (PERMIT2_ADDRESS).
 * Writes the deployed address to EVM_ESCROW_ADAPTER_ADDRESS in the env file.
 *
 * This is the M4 replacement for deploy-evm.ts (which deploys the pre-escrow
 * BosphorAdapter). The current mainnet adapter is a stale pre-M3 deployment, so a
 * fresh testnet deploy is required regardless (see #395).
 *
 * Usage: BOSPHOR_ENV_FILE=.env.testnet npm run deploy:evm-escrow
 * Required env: EVM_RPC_URL, EVM_RELAYER_KEY
 * Optional env: SUI_LZ_PACKAGE_ID (peer), PERMIT2_ADDRESS (USDC path), TRUSTED_RELAYER
 */
import { config } from "dotenv";
import { resolve } from "path";
import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";

const ENV_PATH = process.env.BOSPHOR_ENV_FILE
  ? resolve(process.env.BOSPHOR_ENV_FILE)
  : resolve(import.meta.dirname, "../../.env");
config({ path: ENV_PATH });

import { ethers } from "ethers";

const EVM_RPC_URL = process.env.EVM_RPC_URL;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY;
const SUI_LZ_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID;
const PERMIT2_ADDRESS = process.env.PERMIT2_ADDRESS;

if (!EVM_RPC_URL || !EVM_RELAYER_KEY) {
  console.error("Missing EVM_RPC_URL or EVM_RELAYER_KEY in the env file");
  process.exit(1);
}

const LZ_ENDPOINT = process.env.LZ_ENDPOINT_ADDRESS || "0x6EDCE65403992e310A62460808c4b910D972f10f";
const SUI_EID = Number(process.env.SUI_EID) || 40378;

const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
const wallet = new ethers.Wallet(EVM_RELAYER_KEY, provider);

function updateEnv(updates: Record<string, string>) {
  let content = readFileSync(ENV_PATH, "utf-8");
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) content = content.replace(regex, `${key}=${value}`);
    else content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  writeFileSync(ENV_PATH, content);
}

async function main() {
  const deployer = wallet.address;
  const trustedRelayer = process.env.TRUSTED_RELAYER || deployer;
  console.log("=== Bosphor EVM Escrow Deployment (M4) ===");
  console.log(`  Deployer:        ${deployer}`);
  console.log(`  Trusted relayer: ${trustedRelayer}`);
  console.log(`  RPC:             ${EVM_RPC_URL}`);
  console.log(`  Endpoint:        ${LZ_ENDPOINT}`);

  console.log("\n=== Step 1: Build contracts ===");
  const contractsDir = resolve(import.meta.dirname, "../../contracts/evm");
  const artifactPath = resolve(
    contractsDir,
    "out/BosphorEscrowAdapter.sol/BosphorEscrowAdapter.json",
  );
  try {
    execSync("forge build", { cwd: contractsDir, encoding: "utf-8", stdio: "pipe" });
    console.log("[OK] forge build");
  } catch (err: any) {
    if (existsSync(artifactPath)) console.log("[WARN] forge build failed but artifact exists, continuing...");
    else {
      console.error("[FAIL] forge build:", err.stderr || err.message);
      process.exit(1);
    }
  }

  console.log("\n=== Step 2: Deploy BosphorEscrowAdapter ===");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
  const contract = await factory.deploy(LZ_ENDPOINT, deployer, trustedRelayer);
  await contract.waitForDeployment();
  const adapterAddress = await contract.getAddress();
  console.log(`[OK] BosphorEscrowAdapter deployed: ${adapterAddress}`);

  const adapter = new ethers.Contract(adapterAddress, artifact.abi, wallet);

  if (SUI_LZ_PACKAGE_ID) {
    console.log(`\n=== Step 3: setPeer(${SUI_EID}, ${SUI_LZ_PACKAGE_ID}) ===`);
    const peerBytes32 = "0x" + SUI_LZ_PACKAGE_ID.replace("0x", "").padStart(64, "0");
    const tx = await adapter.setPeer(SUI_EID, peerBytes32);
    await tx.wait();
    console.log(`[OK] setPeer: ${tx.hash}`);
  } else {
    console.log("\n=== Step 3: SKIPPED (SUI_LZ_PACKAGE_ID not set) ===");
    console.log("  Run 'npm run wire' after deploying Sui to configure peers.");
  }

  if (PERMIT2_ADDRESS) {
    console.log(`\n=== Step 4: setPermit2(${PERMIT2_ADDRESS}) [opt-in USDC path] ===`);
    const tx = await adapter.setPermit2(PERMIT2_ADDRESS);
    await tx.wait();
    console.log(`[OK] setPermit2: ${tx.hash}`);
  } else {
    console.log("\n=== Step 4: SKIPPED (PERMIT2_ADDRESS not set; native-only) ===");
  }

  updateEnv({ EVM_ESCROW_ADAPTER_ADDRESS: adapterAddress });

  console.log("\n=== EVM Escrow Deployment Complete ===");
  console.log(`  BosphorEscrowAdapter: ${adapterAddress}`);
  console.log("  Env updated (EVM_ESCROW_ADAPTER_ADDRESS).");
  console.log("  Next: point the relayer at EVM_ESCROW_ADAPTER_ADDRESS, wire the");
  console.log("  EscrowReader, and set BREAK_EVEN_GUARD_ENABLED=true, then e2e.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
