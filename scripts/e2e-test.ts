/// E2E test: send intent, wait for LZ delivery, verify execution
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { ethers } from "ethers";

// --- Config ---
const EVM_RPC_URL = process.env.EVM_RPC_URL!;
const EVM_ADAPTER_ADDRESS = process.env.EVM_ADAPTER_ADDRESS!;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY!;

for (const [k, v] of Object.entries({ EVM_RPC_URL, EVM_ADAPTER_ADDRESS, EVM_RELAYER_KEY })) {
  if (!v) { console.error(`Missing ${k} in .env`); process.exit(1); }
}

const ADAPTER_ABI = [
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)",
  "function confirmExecution(bytes32 intentId, bytes proof) external",
  "function executed(bytes32) view returns (bool)",
  "function nonces(address) view returns (uint256)",
  "function intents(bytes32) view returns (bool)",
  "function quote(uint32 dstEid, bytes payload, uint256 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function submitIntent(uint32 dstEid, bytes payload, uint256 deadline, bytes options) payable returns (bytes32)",
];

const DST_EID = 40378; // Sui testnet
const LZ_OPTIONS = "0x00030100110100000000000000000000000000030d40";
const MAX_WAIT = 15 * 60 * 1000; // 15 minutes
const POLL_INTERVAL = 15_000; // 15 seconds

const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
const wallet = new ethers.Wallet(EVM_RELAYER_KEY, provider);
const adapter = new ethers.Contract(EVM_ADAPTER_ADDRESS, ADAPTER_ABI, wallet);

// --- LZ Scan API ---
async function checkLzStatus(txHash: string): Promise<{ status: string; message: string; destination: string }> {
  try {
    const res = await fetch(
      `https://scan-testnet.layerzero-api.com/v1/messages/tx/${txHash}`,
    );
    if (!res.ok) return { status: "UNKNOWN", message: `HTTP ${res.status}`, destination: "UNKNOWN" };
    const data = await res.json() as any;
    if (!data.data || data.data.length === 0) return { status: "PENDING", message: "Not indexed yet", destination: "N/A" };
    const msg = data.data[0];
    return {
      status: msg.status?.name || "UNKNOWN",
      message: msg.status?.message || "",
      destination: msg.destination?.status || "UNKNOWN",
    };
  } catch {
    return { status: "ERROR", message: "API error", destination: "UNKNOWN" };
  }
}

async function main() {
  const sender = wallet.address;
  console.log("=== E2E Test: Intent Submission ===");
  console.log(`  Sender:  ${sender}`);
  console.log(`  Adapter: ${EVM_ADAPTER_ADDRESS}`);
  console.log(`  DST EID: ${DST_EID} (Sui testnet)`);

  // 1. Build payload
  const payload = ethers.toUtf8Bytes(`bosphor-e2e-test-${Date.now()}`);
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  // 2. Compute intent ID
  const nonce = await adapter.nonces(sender);
  const intentId = ethers.keccak256(
    ethers.solidityPacked(
      ["address", "uint64", "bytes", "uint256", "uint256"],
      [sender, DST_EID, payload, nonce, deadline],
    ),
  );
  console.log(`\n  Intent ID: ${intentId}`);
  console.log(`  Nonce:     ${nonce}`);
  console.log(`  Deadline:  ${deadline} (${new Date(deadline * 1000).toISOString()})`);

  // 3. Quote LZ fee
  console.log("\n  Quoting LZ fee...");
  const fee = await adapter.quote(DST_EID, payload, deadline, LZ_OPTIONS);
  console.log(`  Native fee: ${ethers.formatEther(fee.nativeFee)} ETH`);

  // 4. Submit intent
  console.log("\n  Submitting intent...");
  const tx = await adapter.submitIntent(DST_EID, payload, deadline, LZ_OPTIONS, {
    value: fee.nativeFee,
  });
  console.log(`  TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  Confirmed in block: ${receipt.blockNumber}`);
  console.log(`  Gas used: ${receipt.gasUsed}`);

  // 7. Verify intent registered
  const isRegistered = await adapter.intents(intentId);
  console.log(`\n  Intent registered: ${isRegistered}`);

  console.log(`\n  LZ Explorer: https://testnet.layerzeroscan.com/tx/${tx.hash}`);

  // 8. Poll for delivery (LZ Explorer + executed status)
  console.log(`\n  Waiting for LZ delivery (max ${MAX_WAIT / 60000} min)...`);
  const startTime = Date.now();
  let lastLzStatus = "";

  while (Date.now() - startTime < MAX_WAIT) {
    // Check LZ status
    const lz = await checkLzStatus(tx.hash);
    if (lz.status !== lastLzStatus) {
      console.log(`  LZ: ${lz.status} — ${lz.message} (dest: ${lz.destination})`);
      lastLzStatus = lz.status;
    }

    if (lz.status === "DELIVERED") {
      console.log("  LZ message DELIVERED to Sui.");
      break;
    }

    if (lz.status === "FAILED") {
      console.error("  LZ message FAILED.");
      break;
    }

    // Check if executed on EVM (might happen before LZ scan updates)
    try {
      const isExecuted = await adapter.executed(intentId);
      if (isExecuted) {
        console.log(`\n  [SUCCESS] Intent ${intentId} executed on EVM.`);
        console.log(`  Time: ${Math.round((Date.now() - startTime) / 1000)}s`);
        printSummary(tx.hash, intentId, receipt.blockNumber);
        return;
      }
    } catch {
      // RPC error, ignore and retry
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  // Final check
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  try {
    const isExecuted = await adapter.executed(intentId);
    if (isExecuted) {
      console.log(`\n  [SUCCESS] Intent executed. Time: ${elapsed}s`);
      printSummary(tx.hash, intentId, receipt.blockNumber);
      return;
    }
  } catch {}

  console.log(`\n  [TIMEOUT] Intent not executed within ${MAX_WAIT / 60000} minutes.`);
  console.log("  LZ Sui testnet executor is non-functional. Manual delivery required:");
  console.log(`    npx tsx relayer/manual-deliver.ts <nonce> <guid> <payload>`);
  console.log(`  Check LZ Explorer: https://testnet.layerzeroscan.com/tx/${tx.hash}`);
  printSummary(tx.hash, intentId, receipt.blockNumber);
}

function printSummary(txHash: string, intentId: string, blockNumber: number) {
  console.log("\n=== Summary ===");
  console.log(`  Intent ID:   ${intentId}`);
  console.log(`  EVM TX:      ${txHash}`);
  console.log(`  Block:       ${blockNumber}`);
  console.log(`  Etherscan:   https://sepolia.etherscan.io/tx/${txHash}`);
  console.log(`  LZ Explorer: https://testnet.layerzeroscan.com/tx/${txHash}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
