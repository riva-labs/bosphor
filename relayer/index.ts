import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });
import { ethers } from "ethers";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

// --- Config ---
const {
  EVM_RPC_URL,
  EVM_ADAPTER_ADDRESS,
  SUI_RPC_URL = "https://fullnode.testnet.sui.io:443",
  SUI_PACKAGE_ID,
  SUI_CONFIG_ID,
  SUI_LZ_PACKAGE_ID,
  SUI_RELAYER_KEY,
  EVM_RELAYER_KEY,
  WALRUS_PUBLISHER_URL = "https://publisher.walrus-testnet.walrus.space",
  WALRUS_AGGREGATOR_URL = "https://aggregator.walrus-testnet.walrus.space",
  WALRUS_STORE_EPOCHS = "5",
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
const suiLzPkgId = SUI_LZ_PACKAGE_ID ?? "";
const suiRelayerKey = requireEnv("SUI_RELAYER_KEY", SUI_RELAYER_KEY);
const evmRelayerKey = requireEnv("EVM_RELAYER_KEY", EVM_RELAYER_KEY);

// --- ABI ---
const ADAPTER_ABI = [
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)",
  "function confirmExecution(bytes32 intentId, bytes proof) external",
  "function executed(bytes32) view returns (bool)",
  "function quote(uint32 dstEid, bytes payload, uint256 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function submitIntent(uint32 dstEid, bytes payload, uint256 deadline, bytes options) payable returns (bytes32)",
];

// --- Providers & Signers ---
const evmProvider = new ethers.JsonRpcProvider(evmRpc, undefined, {
  staticNetwork: true,
  polling: true,
});
const evmWallet = new ethers.Wallet(evmRelayerKey, evmProvider);
const adapter = new ethers.Contract(adapterAddr, ADAPTER_ABI, evmWallet);

const suiClient = new SuiClient({ url: SUI_RPC_URL! });
const suiKeypair = suiRelayerKey.startsWith("suipriv")
  ? (() => {
      const { schema, secretKey } = decodeSuiPrivateKey(suiRelayerKey);
      if (schema !== "ED25519") throw new Error(`Unsupported key schema: ${schema}`);
      return Ed25519Keypair.fromSecretKey(secretKey);
    })()
  : Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(suiRelayerKey, "base64")));

const relayerSuiAddress = suiKeypair.toSuiAddress();

// Sui Clock shared object (0x6 is the well-known Clock object ID)
const SUI_CLOCK_OBJECT = "0x6";

// --- Intent deduplication ---
const processedIntents = new Set<string>();

// --- Walrus Publisher upload ---
interface WalrusBlobInfo {
  blobId: string;
  suiObjectId: string;
  endEpoch: number;
}

async function uploadToWalrus(payload: Uint8Array): Promise<WalrusBlobInfo> {
  const url = `${WALRUS_PUBLISHER_URL}/v1/blobs?epochs=${WALRUS_STORE_EPOCHS}&send_object_to=${relayerSuiAddress}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: Buffer.from(payload),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Walrus upload failed (${res.status}): ${body}`);
  }

  const data = await res.json() as Record<string, any>;

  if (data.newlyCreated) {
    const blob = data.newlyCreated.blobObject;
    return {
      blobId: blob.blobId,
      suiObjectId: blob.id,
      endEpoch: blob.storage?.endEpoch ?? 0,
    };
  }
  if (data.alreadyCertified) {
    return {
      blobId: data.alreadyCertified.blobId,
      suiObjectId: "",
      endEpoch: data.alreadyCertified.endEpoch ?? 0,
    };
  }

  throw new Error(`Unexpected Walrus response: ${JSON.stringify(data)}`);
}

// --- Find Blob object owned by relayer ---
async function findBlobObject(blobId: string): Promise<string> {
  const objects = await suiClient.getOwnedObjects({
    owner: relayerSuiAddress,
    filter: { StructType: `${walrusPackageId()}::blob::Blob` },
    options: { showContent: true },
  });

  for (const obj of objects.data) {
    const content = obj.data?.content;
    if (content && content.dataType === "moveObject") {
      const fields = content.fields as Record<string, any>;
      if (fields.blob_id === blobId) {
        return obj.data!.objectId;
      }
    }
  }

  throw new Error(`Blob object not found for blobId: ${blobId}`);
}

function walrusPackageId(): string {
  return "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66";
}

// --- Sui execution ---
async function executeOnSui(
  intentId: string,
  sender: string,
  blobObjectId: string,
  deadlineMs: bigint,
): Promise<string> {
  const tx = new Transaction();
  tx.moveCall({
    target: `${suiPkgId}::walrus_executor::execute_store`,
    arguments: [
      tx.object(suiConfigId),
      tx.pure.vector("u8", Array.from(ethers.getBytes(intentId))),
      tx.object(blobObjectId),
      tx.pure.u64(deadlineMs),
      tx.object(SUI_CLOCK_OBJECT),
      tx.pure.address(sender),
    ],
  });

  const result = await suiClient.signAndExecuteTransaction({
    signer: suiKeypair,
    transaction: tx,
    options: { showEffects: true },
  });

  const status = result.effects?.status?.status;
  if (status !== "success") {
    throw new Error(`Sui tx failed: ${JSON.stringify(result.effects?.status)}`);
  }

  console.log(`  Sui tx digest: ${result.digest}`);
  return result.digest;
}

// --- EVM confirmation ---
async function confirmOnEvm(intentId: string, walrusBlobId: string, suiDigest: string) {
  const proof = JSON.stringify({ blobId: walrusBlobId, suiDigest });
  const tx = await adapter.confirmExecution(intentId, ethers.toUtf8Bytes(proof));
  const receipt = await tx.wait();
  console.log(`  EVM confirm tx: ${receipt.hash}`);
}

// --- Polling-based listener ---
const POLL_INTERVAL = 5_000;
const intentFilter = adapter.filters.IntentSubmitted();

async function pollEvents(fromBlock: number): Promise<number> {
  const latestBlock = await evmProvider.getBlockNumber();
  if (fromBlock > latestBlock) return fromBlock;

  const logs = await adapter.queryFilter(intentFilter, fromBlock, latestBlock);

  for (const log of logs) {
    const parsed = adapter.interface.parseLog({
      topics: log.topics as string[],
      data: log.data,
    });
    if (!parsed) continue;

    const { intentId, sender, targetChainId, payload, nonce, deadline } = parsed.args;

    // Dedup: skip if already processed
    if (processedIntents.has(intentId)) {
      console.log(`[Skip] ${intentId} — already processed`);
      continue;
    }

    // Deadline check: skip expired intents (deadline is in seconds, convert to ms)
    const deadlineMs = BigInt(deadline) * 1000n;
    if (Date.now() > Number(deadlineMs)) {
      console.log(`[Skip] ${intentId} — deadline expired`);
      processedIntents.add(intentId);
      continue;
    }

    console.log(`[Intent] ${intentId}`);
    console.log(`  from: ${sender}, chain: ${targetChainId}, nonce: ${nonce}`);

    try {
      // 1. Upload payload to Walrus
      console.log(`  Uploading to Walrus...`);
      const payloadBytes = ethers.getBytes(payload);
      const walrus = await uploadToWalrus(payloadBytes);
      console.log(`  Walrus blobId: ${walrus.blobId}`);
      console.log(`  Walrus object: ${walrus.suiObjectId}`);
      console.log(`  Expires epoch: ${walrus.endEpoch}`);
      console.log(`  Verify: ${WALRUS_AGGREGATOR_URL}/v1/blobs/${walrus.blobId}`);

      // 2. Find blob object if not returned directly
      let blobObjectId = walrus.suiObjectId;
      if (!blobObjectId) {
        console.log(`  Looking up Blob object...`);
        blobObjectId = await findBlobObject(walrus.blobId);
        console.log(`  Found: ${blobObjectId}`);
      }

      // 3. Record on Sui — pass real Walrus Blob object + deadline
      const suiDigest = await executeOnSui(intentId, sender, blobObjectId, deadlineMs);

      // 4. Confirm on EVM only if Sui succeeded
      await confirmOnEvm(intentId, walrus.blobId, suiDigest);

      processedIntents.add(intentId);
      console.log(`  [OK] Intent ${intentId} fulfilled\n`);
    } catch (err) {
      console.error(`  [ERR] Intent ${intentId} failed:`, err);
      // Do NOT mark as processed — allow retry on next poll
    }
  }

  return latestBlock + 1;
}

// --- Sui LZ event polling ---
interface SuiEventCursor {
  txDigest: string;
  eventSeq: string;
}

let suiEventCursor: SuiEventCursor | null = null;

async function pollSuiEvents(): Promise<void> {
  if (!suiLzPkgId) return;

  const eventType = `${suiLzPkgId}::lz_receiver::IntentReceived`;
  const result = await suiClient.queryEvents({
    query: { MoveEventType: eventType },
    cursor: suiEventCursor ?? undefined,
    order: "ascending",
    limit: 50,
  });

  for (const event of result.data) {
    const fields = event.parsedJson as Record<string, any>;
    const intentIdBytes: number[] = fields.intent_id;
    const intentId = "0x" + intentIdBytes.map((b: number) => b.toString(16).padStart(2, "0")).join("");
    const payload: number[] = fields.payload;

    if (processedIntents.has(intentId)) {
      continue;
    }

    // Decode ABI-encoded message: (bytes32 intentId, address sender, bytes payload, uint256 deadline)
    const payloadHex = "0x" + payload.map((b: number) => b.toString(16).padStart(2, "0")).join("");
    let sender: string;
    let userPayload: string;
    let deadlineMs: bigint;
    try {
      const decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bytes32", "address", "bytes", "uint256"],
        payloadHex,
      );
      sender = decoded[1];
      userPayload = decoded[2];
      deadlineMs = BigInt(decoded[3]) * 1000n;
    } catch {
      console.error(`  [ERR] Failed to decode ABI payload for ${intentId}`);
      processedIntents.add(intentId);
      continue;
    }

    if (Date.now() > Number(deadlineMs)) {
      console.log(`[Skip] ${intentId} — deadline expired (via Sui LZ)`);
      processedIntents.add(intentId);
      continue;
    }

    console.log(`[Intent/LZ] ${intentId}`);
    console.log(`  from: ${sender}, src_eid: ${fields.src_eid}, nonce: ${fields.nonce}`);

    try {
      // 1. Upload user payload to Walrus
      console.log(`  Uploading to Walrus...`);
      const payloadBytes = ethers.getBytes(userPayload);
      const walrus = await uploadToWalrus(payloadBytes);
      console.log(`  Walrus blobId: ${walrus.blobId}`);
      console.log(`  Walrus object: ${walrus.suiObjectId}`);

      // 2. Find blob object if not returned directly
      let blobObjectId = walrus.suiObjectId;
      if (!blobObjectId) {
        console.log(`  Looking up Blob object...`);
        blobObjectId = await findBlobObject(walrus.blobId);
        console.log(`  Found: ${blobObjectId}`);
      }

      // 3. Record on Sui — pass real Walrus Blob object + deadline
      const suiDigest = await executeOnSui(intentId, sender, blobObjectId, deadlineMs);

      // 4. Confirm on EVM
      await confirmOnEvm(intentId, walrus.blobId, suiDigest);

      processedIntents.add(intentId);
      console.log(`  [OK] Intent ${intentId} fulfilled (via Sui LZ)\n`);
    } catch (err) {
      console.error(`  [ERR] Intent ${intentId} failed:`, err);
    }
  }

  if (result.hasNextPage && result.nextCursor) {
    suiEventCursor = result.nextCursor as SuiEventCursor;
  } else if (result.data.length > 0) {
    const last = result.data[result.data.length - 1];
    suiEventCursor = { txDigest: last.id.txDigest, eventSeq: last.id.eventSeq };
  }
}

async function main() {
  console.log("Bosphor Relayer starting...");
  console.log(`  EVM adapter:  ${adapterAddr}`);
  console.log(`  Sui package:  ${suiPkgId}`);
  console.log(`  Sui LZ pkg:   ${suiLzPkgId || "(not configured — EVM-only mode)"}`);
  console.log(`  Sui relayer:  ${relayerSuiAddress}`);
  console.log(`  Walrus pub:   ${WALRUS_PUBLISHER_URL}`);
  console.log(`  Walrus agg:   ${WALRUS_AGGREGATOR_URL}`);

  let fromBlock = await evmProvider.getBlockNumber();
  console.log(`  Starting from block: ${fromBlock}`);
  console.log(`  Polling every ${POLL_INTERVAL / 1000}s for events...\n`);

  const poll = async () => {
    try {
      // Poll Sui LZ events (primary path when configured)
      await pollSuiEvents();
      // Poll EVM events (fallback / backward-compatible)
      fromBlock = await pollEvents(fromBlock);
    } catch (err) {
      console.error("[Poll error]", err);
    }
    setTimeout(poll, POLL_INTERVAL);
  };

  poll();
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
