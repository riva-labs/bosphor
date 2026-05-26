/**
 * e2e-test.ts
 *
 * Two-step E2E verification: tests the full Bosphor round-trip.
 *
 * Phase 1 (Forward): EVM submitIntent -> LayerZero -> Sui delivery
 * Phase 2 (Return):  Relayer -> Walrus upload -> execute_store -> LZ return -> EVM proof receipt
 *
 * Polls LayerZero Scan API and on-chain state to verify both directions.
 * Reports the full TX chain with explorer links for Foundation verification.
 *
 * Usage: npm run test:e2e
 * Required env: EVM_RPC_URL, EVM_ADAPTER_ADDRESS, EVM_RELAYER_KEY
 * Optional env: SUI_RPC_URL, SUI_PACKAGE_ID, SUI_LZ_PACKAGE_ID (for Sui event details)
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { ethers, EventLog } from "ethers";
import { SuiClient } from "@mysten/sui/client";

// --- Config ---
const EVM_RPC_URL = process.env.EVM_RPC_URL!;
const EVM_ADAPTER_ADDRESS = process.env.EVM_ADAPTER_ADDRESS!;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY!;

for (const [k, v] of Object.entries({
  EVM_RPC_URL,
  EVM_ADAPTER_ADDRESS,
  EVM_RELAYER_KEY,
})) {
  if (!v) {
    console.error(`Missing ${k} in .env`);
    process.exit(1);
  }
}

// Sui config (optional, for detailed event queries)
const SUI_RPC_URL =
  process.env.SUI_RPC_URL || "https://fullnode.testnet.sui.io:443";
const SUI_PACKAGE_ID = process.env.SUI_PACKAGE_ID;
const SUI_LZ_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID;

const ADAPTER_ABI = [
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)",
  "event IntentExecuted(bytes32 indexed intentId, bytes proof)",
  "function confirmExecution(bytes32 intentId, bytes proof) external",
  "function executed(bytes32) view returns (bool)",
  "function nonces(address) view returns (uint256)",
  "function intents(bytes32) view returns (bool)",
  "function quote(uint32 dstEid, bytes payload, uint256 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function submitIntent(uint32 dstEid, bytes payload, uint256 deadline, bytes options) payable returns (bytes32)",
];

const DST_EID = 40378; // Sui testnet
const LZ_OPTIONS = "0x00030100110100000000000000000000000000030d40";
const MAX_WAIT = 15 * 60 * 1000; // 15 minutes per phase
const POLL_INTERVAL = 15_000; // 15 seconds

const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, {
  staticNetwork: true,
});
const wallet = new ethers.Wallet(EVM_RELAYER_KEY, provider);
const adapter = new ethers.Contract(EVM_ADAPTER_ADDRESS, ADAPTER_ABI, wallet);

// --- Helpers ---

function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes: number[] = [];
  for (let i = 0; i < clean.length; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

function bytesMatch(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function checkLzStatus(
  txHash: string,
): Promise<{ status: string; message: string; destination: string }> {
  try {
    const res = await fetch(
      `https://scan-testnet.layerzero-api.com/v1/messages/tx/${txHash}`,
    );
    if (!res.ok)
      return {
        status: "UNKNOWN",
        message: `HTTP ${res.status}`,
        destination: "UNKNOWN",
      };
    const data = (await res.json()) as any;
    if (!data.data || data.data.length === 0)
      return {
        status: "PENDING",
        message: "Not indexed yet",
        destination: "N/A",
      };
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

interface SuiEventResult {
  storageExecuted?: {
    txDigest: string;
    blobId: string;
    endEpoch: number;
    executor: string;
  };
  proofSent?: {
    txDigest: string;
    blobId: string;
    endEpoch: number;
    dstEid: number;
    nonce: number;
  };
}

async function querySuiEvents(intentId: string): Promise<SuiEventResult> {
  const result: SuiEventResult = {};

  if (!SUI_PACKAGE_ID && !SUI_LZ_PACKAGE_ID) return result;

  const suiClient = new SuiClient({ url: SUI_RPC_URL });
  const intentBytes = hexToBytes(intentId);

  // Query StorageExecuted events
  if (SUI_PACKAGE_ID) {
    try {
      const eventType = `${SUI_PACKAGE_ID}::walrus_executor::StorageExecuted`;
      const events = await suiClient.queryEvents({
        query: { MoveEventType: eventType },
        order: "descending",
        limit: 20,
      });

      for (const ev of events.data) {
        const fields = ev.parsedJson as any;
        if (
          fields?.intent_id &&
          bytesMatch(fields.intent_id, intentBytes)
        ) {
          const blobHex = BigInt(fields.walrus_blob_id)
            .toString(16)
            .padStart(64, "0");
          result.storageExecuted = {
            txDigest: ev.id.txDigest,
            blobId: `0x${blobHex}`,
            endEpoch: Number(fields.end_epoch),
            executor: fields.executor,
          };
          break;
        }
      }
    } catch (err) {
      console.log(
        "  [info] Could not query StorageExecuted events:",
        (err as Error).message,
      );
    }
  }

  // Query ProofSent events
  if (SUI_LZ_PACKAGE_ID) {
    try {
      const eventType = `${SUI_LZ_PACKAGE_ID}::lz_receiver::ProofSent`;
      const events = await suiClient.queryEvents({
        query: { MoveEventType: eventType },
        order: "descending",
        limit: 20,
      });

      for (const ev of events.data) {
        const fields = ev.parsedJson as any;
        if (
          fields?.intent_id &&
          bytesMatch(fields.intent_id, intentBytes)
        ) {
          const blobBytes: number[] = fields.blob_id;
          const blobHex = blobBytes
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join("");
          result.proofSent = {
            txDigest: ev.id.txDigest,
            blobId: `0x${blobHex}`,
            endEpoch: Number(fields.end_epoch),
            dstEid: Number(fields.dst_eid),
            nonce: Number(fields.nonce),
          };
          break;
        }
      }
    } catch (err) {
      console.log(
        "  [info] Could not query ProofSent events:",
        (err as Error).message,
      );
    }
  }

  return result;
}

// --- Main ---

async function main() {
  const sender = wallet.address;
  console.log("=".repeat(56));
  console.log("  Bosphor E2E: Two-Step Verification");
  console.log("=".repeat(56));
  console.log(`  Sender:  ${sender}`);
  console.log(`  Adapter: ${EVM_ADAPTER_ADDRESS}`);
  console.log(`  DST EID: ${DST_EID} (Sui testnet)`);

  // ── Build and submit intent ──

  const payload = ethers.toUtf8Bytes(`bosphor-e2e-${Date.now()}`);
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const nonce = await adapter.nonces(sender);
  const intentId = ethers.keccak256(
    ethers.solidityPacked(
      ["address", "uint64", "bytes", "uint256", "uint256"],
      [sender, DST_EID, payload, nonce, deadline],
    ),
  );
  console.log(`\n  Intent ID: ${intentId}`);
  console.log(`  Nonce:     ${nonce}`);
  console.log(
    `  Deadline:  ${deadline} (${new Date(deadline * 1000).toISOString()})`,
  );

  console.log("\n  Quoting LZ fee...");
  const fee = await adapter.quote(DST_EID, payload, deadline, LZ_OPTIONS);
  console.log(`  Native fee: ${ethers.formatEther(fee.nativeFee)} ETH`);

  console.log("\n  Submitting intent...");
  const tx = await adapter.submitIntent(
    DST_EID,
    payload,
    deadline,
    LZ_OPTIONS,
    { value: fee.nativeFee },
  );
  console.log(`  TX hash: ${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt) {
    console.error("\n  [FAIL] TX receipt is null, transaction may have been dropped.");
    process.exit(1);
  }
  const submitBlock = receipt.blockNumber;
  console.log(`  Confirmed in block: ${submitBlock}`);
  console.log(`  Gas used: ${receipt.gasUsed}`);

  const isRegistered = await adapter.intents(intentId);
  console.log(`  Intent registered: ${isRegistered}`);

  if (!isRegistered) {
    console.error("\n  [FAIL] Intent not registered on-chain.");
    process.exit(1);
  }

  console.log(`\n  [1/6] EVM intent TX`);
  console.log(`        TX:        ${tx.hash}`);
  console.log(
    `        Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}`,
  );
  console.log(
    `        LZ:        https://testnet.layerzeroscan.com/tx/${tx.hash}`,
  );

  // ── Phase 1: Forward LZ delivery (EVM -> Sui) ──

  console.log(
    `\n-- Phase 1: Forward LZ Delivery (EVM -> Sui) --`,
  );
  console.log(`  Polling LZ Scan (max ${MAX_WAIT / 60000} min)...`);

  const startTime = Date.now(); // Tracks total round-trip time from Phase 1 start
  let forwardDelivered = false;
  let executedOnEvm = false;
  let lastLzStatus = "";

  while (Date.now() - startTime < MAX_WAIT) {
    // Check forward LZ status
    if (!forwardDelivered) {
      const lz = await checkLzStatus(tx.hash);
      if (lz.status !== lastLzStatus) {
        console.log(
          `  LZ: ${lz.status} -- ${lz.message} (dest: ${lz.destination})`,
        );
        lastLzStatus = lz.status;
      }

      if (lz.status === "DELIVERED") {
        forwardDelivered = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n  [2/6] LZ forward DELIVERED (${elapsed}s)`);
        console.log("  Checking for early return path completion...");
      }

      if (lz.status === "FAILED") {
        console.error("\n  [FAIL] Forward LZ message FAILED.");
        process.exit(1);
      }
    }

    // Check if return path already completed
    try {
      const isExecuted = await adapter.executed(intentId);
      if (isExecuted) {
        executedOnEvm = true;
        if (!forwardDelivered) {
          console.log(
            `\n  [2/6] LZ forward delivered (detected via EVM execution)`,
          );
          forwardDelivered = true;
        }
        break;
      }
    } catch {
      // RPC error, retry next cycle
    }

    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, POLL_INTERVAL));
  }

  if (!forwardDelivered) {
    console.log(
      `\n  [TIMEOUT] Forward delivery not confirmed within ${MAX_WAIT / 60000} min.`,
    );
    console.log("  The LZ Sui testnet executor may be slow. Check LZ Explorer.");
    process.exit(1);
  }

  // ── Phase 2: Return path (Sui -> EVM) ──

  if (!executedOnEvm) {
    console.log(
      `\n-- Phase 2: Return Path (Sui -> EVM) --`,
    );
    console.log(
      "  Waiting for relayer to process and send proof back...",
    );

    const phase2Start = Date.now();

    while (Date.now() - phase2Start < MAX_WAIT) {
      try {
        const isExecuted = await adapter.executed(intentId);
        if (isExecuted) {
          executedOnEvm = true;
          break;
        }
      } catch {
        // RPC error, retry
      }

      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
    }
  }

  if (!executedOnEvm) {
    console.log(
      `\n  [TIMEOUT] Return path not completed within ${MAX_WAIT / 60000} min.`,
    );
    console.log("  Ensure the relayer is running: npm run relayer:dev");
    process.exit(1);
  }

  const totalElapsed = Math.round((Date.now() - startTime) / 1000);
  console.log(`\n  Return path completed. Total time: ${totalElapsed}s`);

  // ── Collect verification data ──

  console.log("\n-- Collecting verification data --");

  let blobId = "(unknown)";
  let endEpoch = "(unknown)";
  let proofTxHash = "(unknown)";
  let suiStorageTx = "(not available)";
  let suiProofTx = "(not available)";
  let returnLzStatus = "(not checked)";

  // Query Sui events for intermediate steps (checkpoints 3, 4, 5)
  const suiEvents = await querySuiEvents(intentId);

  if (suiEvents.storageExecuted) {
    const se = suiEvents.storageExecuted;
    suiStorageTx = se.txDigest;
    blobId = se.blobId;
    endEpoch = se.endEpoch.toString();
    console.log(`  [3/6] Sui execution`);
    console.log(`        TX:       ${se.txDigest}`);
    console.log(
      `        Explorer: https://suiscan.xyz/testnet/tx/${se.txDigest}`,
    );
    console.log(`  [4/6] Walrus blob`);
    console.log(`        Blob ID:  ${se.blobId}`);
    console.log(`        End epoch: ${se.endEpoch}`);
  } else {
    console.log(
      "  [3/6] Sui execution: (set SUI_PACKAGE_ID for details)",
    );
    console.log("  [4/6] Walrus blob:   (set SUI_PACKAGE_ID for details)");
  }

  if (suiEvents.proofSent) {
    const ps = suiEvents.proofSent;
    suiProofTx = ps.txDigest;
    console.log(`  [5/6] LZ return proof`);
    console.log(`        TX:       ${ps.txDigest}`);
    console.log(
      `        Explorer: https://suiscan.xyz/testnet/tx/${ps.txDigest}`,
    );

    // Check return LZ message status
    try {
      const lz = await checkLzStatus(ps.txDigest);
      returnLzStatus = lz.status;
      console.log(`        LZ status: ${lz.status} -- ${lz.message}`);
    } catch {
      returnLzStatus = "(API error)";
    }
  } else {
    console.log(
      "  [5/6] LZ return proof: (set SUI_LZ_PACKAGE_ID for details)",
    );
  }

  // Query IntentExecuted event on EVM (checkpoint 6)
  try {
    const filter = adapter.filters.IntentExecuted(intentId);
    const events = await adapter.queryFilter(filter, submitBlock);

    if (events.length > 0 && events[0] instanceof EventLog) {
      const event = events[0];
      proofTxHash = event.transactionHash;

      // Decode proof: abi.encode(bytes32 blobId, uint256 endEpoch)
      const proofData = event.args.proof;
      if (proofData) {
        const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
          ["bytes32", "uint256"],
          proofData,
        );
        if (blobId === "(unknown)") blobId = decoded[0] as string;
        if (endEpoch === "(unknown)") endEpoch = decoded[1].toString();
      }

      console.log(`  [6/6] EVM proof receipt`);
      console.log(`        TX:        ${proofTxHash}`);
      console.log(
        `        Etherscan: https://sepolia.etherscan.io/tx/${proofTxHash}`,
      );
      console.log(`        Blob ID:   ${blobId}`);
      console.log(`        End epoch: ${endEpoch}`);
    }
  } catch (err) {
    console.log(
      `  [info] Could not query IntentExecuted event: ${(err as Error).message}`,
    );
  }

  // ── Verify proof data was decoded ──

  if (blobId === "(unknown)" || endEpoch === "(unknown)") {
    console.error("\n  [FAIL] Could not decode proof data (blobId, endEpoch).");
    console.error("  Intent is marked executed but proof contents are unverified.");
    process.exit(1);
  }

  // ── Final summary ──

  console.log("\n" + "=".repeat(56));
  console.log("  VERIFICATION SUMMARY");
  console.log("=".repeat(56));
  console.log(`  Intent ID:  ${intentId}`);
  console.log(`  Total time: ${totalElapsed}s`);
  console.log("");
  console.log("  Forward Path (EVM -> Sui):");
  console.log(`    [1] EVM submit TX:      ${tx.hash}`);
  console.log(`    [2] LZ forward:         DELIVERED`);
  console.log("");
  console.log("  Return Path (Sui -> EVM):");
  console.log(`    [3] Sui execution TX:   ${suiStorageTx}`);
  console.log(`    [4] Walrus blob ID:     ${blobId}`);
  console.log(`    [5] LZ return TX:       ${suiProofTx}`);
  console.log(`    [5] LZ return status:   ${returnLzStatus}`);
  console.log(`    [6] EVM proof TX:       ${proofTxHash}`);
  console.log("");
  console.log("  Explorer Links:");
  console.log(
    `    Etherscan (submit):   https://sepolia.etherscan.io/tx/${tx.hash}`,
  );
  console.log(
    `    LZ Explorer:          https://testnet.layerzeroscan.com/tx/${tx.hash}`,
  );
  if (suiStorageTx !== "(not available)") {
    console.log(
      `    Sui Explorer (exec):  https://suiscan.xyz/testnet/tx/${suiStorageTx}`,
    );
  }
  if (suiProofTx !== "(not available)") {
    console.log(
      `    Sui Explorer (proof): https://suiscan.xyz/testnet/tx/${suiProofTx}`,
    );
  }
  if (proofTxHash !== "(unknown)") {
    console.log(
      `    Etherscan (proof):    https://sepolia.etherscan.io/tx/${proofTxHash}`,
    );
  }
  console.log("");
  console.log("  [SUCCESS] Two-step verification complete.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
