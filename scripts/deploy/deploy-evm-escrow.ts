/**
 * deploy-evm-escrow.ts
 *
 * Builds and deploys the M4 BosphorEscrowAdapter (origin-chain escrow) to the
 * EVM chain behind EVM_RPC_URL (Sepolia on testnet), configures setPeer for the Sui LZ OApp when SUI_LZ_PACKAGE_ID is set,
 * and optionally wires Permit2 for the opt-in USDC path (PERMIT2_ADDRESS).
 * Writes the deployed address to EVM_ESCROW_ADAPTER_ADDRESS in the env file.
 *
 * This is the M4 replacement for deploy-evm.ts (which deploys the pre-escrow
 * BosphorAdapter). The current mainnet adapter is a stale pre-M3 deployment, so a
 * fresh testnet deploy is required regardless (see #395).
 *
 * Usage: BOSPHOR_ENV_FILE=.env.testnet npm run deploy:evm-escrow
 * Required env: EVM_RPC_URL, EVM_RELAYER_KEY
 * Required on NETWORK=mainnet: LZ_ENDPOINT_ADDRESS (the chain's EndpointV2),
 *   EVM_CHAIN_ID (checked against the RPC so the wrong chain is never used)
 * Optional env: NETWORK (testnet|mainnet, default testnet), SUI_EID,
 *   SUI_LZ_PACKAGE_ID (peer), PERMIT2_ADDRESS (USDC path), TRUSTED_RELAYER
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
import { presetEid, presetEnv, resolveNetwork } from "../util/network.js";

const EVM_RPC_URL = process.env.EVM_RPC_URL;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY;
const SUI_LZ_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID;
const PERMIT2_ADDRESS = process.env.PERMIT2_ADDRESS;

if (!EVM_RPC_URL || !EVM_RELAYER_KEY) {
  console.error("Missing EVM_RPC_URL or EVM_RELAYER_KEY in the env file");
  process.exit(1);
}

// Sepolia defaults on testnet only; on mainnet the endpoint must be explicit.
const NETWORK = resolveNetwork();
const LZ_ENDPOINT = presetEnv("LZ_ENDPOINT_ADDRESS", NETWORK);
const SUI_EID = presetEid("SUI_EID", NETWORK);
if (NETWORK === "mainnet" && !process.env.EVM_CHAIN_ID) {
  console.error("NETWORK=mainnet requires EVM_CHAIN_ID (the target EVM chain) in the env file");
  process.exit(1);
}

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
  // On mainnet, refuse to deploy unless the RPC is on the chain we intend.
  const { chainId } = await provider.getNetwork();
  if (process.env.EVM_CHAIN_ID && chainId !== BigInt(process.env.EVM_CHAIN_ID)) {
    throw new Error(`EVM_RPC_URL is on chain ${chainId}, expected EVM_CHAIN_ID=${process.env.EVM_CHAIN_ID}`);
  }
  console.log("=== Bosphor EVM Escrow Deployment (M4) ===");
  console.log(`  Network:         ${NETWORK} (chain ${chainId}, Sui EID ${SUI_EID})`);
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
