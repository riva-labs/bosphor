import "dotenv/config";
import { ethers } from "ethers";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";

// --- Config ---
const {
  EVM_RPC_URL,
  EVM_ADAPTER_ADDRESS,
  SUI_RPC_URL = "https://fullnode.testnet.sui.io:443",
  SUI_PACKAGE_ID,
  SUI_CONFIG_ID,
  SUI_RELAYER_KEY,
  EVM_RELAYER_KEY,
} = process.env;

function requireEnv(name: string, value?: string): string {
  if (!value) {
    console.error(`Missing env: ${name}`);
    process.exit(1);
  }
  return value;
}

const evmRpc = requireEnv("EVM_RPC_URL", EVM_RPC_URL);
const adapterAddr = requireEnv("EVM_ADAPTER_ADDRESS", EVM_ADAPTER_ADDRESS);
const suiPkgId = requireEnv("SUI_PACKAGE_ID", SUI_PACKAGE_ID);
const suiConfigId = requireEnv("SUI_CONFIG_ID", SUI_CONFIG_ID);
const suiRelayerKey = requireEnv("SUI_RELAYER_KEY", SUI_RELAYER_KEY);
const evmRelayerKey = requireEnv("EVM_RELAYER_KEY", EVM_RELAYER_KEY);

// --- ABI (only what we need) ---
const ADAPTER_ABI = [
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)",
  "function confirmExecution(bytes32 intentId, bytes proof) external",
];

// --- Providers & Signers ---
const evmProvider = new ethers.JsonRpcProvider(evmRpc);
const evmWallet = new ethers.Wallet(evmRelayerKey, evmProvider);
const adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, evmWallet);

const suiClient = new SuiClient({ url: SUI_RPC_URL! });
const suiKeypair = Ed25519Keypair.fromSecretKey(fromBase64(suiRelayerKey));

// --- Sui execution ---
async function executeOnSui(
  intentId: string,
  sender: string,
  payload: Uint8Array
): Promise<string> {
  // Simulate Walrus blob store — in production this calls the Walrus HTTP API
  // For POC we store the payload hash as blob_id
  const blobId = ethers.keccak256(payload);

  const tx = new Transaction();
  tx.moveCall({
    target: `${suiPkgId}::walrus_executor::execute_store`,
    arguments: [
      tx.object(suiConfigId),
      tx.pure.vector("u8", Array.from(ethers.getBytes(intentId))),
      tx.pure.vector("u8", Array.from(ethers.getBytes(blobId))),
      tx.pure.address(sender), // original EVM sender mapped — for POC, use relayer addr
    ],
  });

  const result = await suiClient.signAndExecuteTransaction({
    signer: suiKeypair,
    transaction: tx,
    options: { showEffects: true },
  });

  console.log(`  Sui tx digest: ${result.digest}`);
  return result.digest;
}

// --- EVM confirmation ---
async function confirmOnEvm(intentId: string, suiDigest: string) {
  const proof = ethers.toUtf8Bytes(suiDigest);
  const tx = await adapter.confirmExecution(intentId, proof);
  const receipt = await tx.wait();
  console.log(`  EVM confirm tx: ${receipt.hash}`);
}

// --- Listener ---
async function main() {
  console.log("Bosphor Relayer starting...");
  console.log(`  EVM adapter: ${adapterAddr}`);
  console.log(`  Sui package:  ${suiPkgId}`);
  console.log(`  Listening for IntentSubmitted events...\n`);

  adapter.on(
    "IntentSubmitted",
    async (
      intentId: string,
      sender: string,
      targetChainId: bigint,
      payload: string,
      nonce: bigint,
      deadline: bigint
    ) => {
      console.log(`[Intent] ${intentId}`);
      console.log(`  from: ${sender}, chain: ${targetChainId}, nonce: ${nonce}`);

      try {
        // 1. Execute on Sui (store blob)
        const suiDigest = await executeOnSui(
          intentId,
          sender,
          ethers.getBytes(payload)
        );

        // 2. Confirm back on EVM
        await confirmOnEvm(intentId, suiDigest);

        console.log(`  [OK] Intent ${intentId} fulfilled\n`);
      } catch (err) {
        console.error(`  [ERR] Intent ${intentId} failed:`, err);
      }
    }
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
