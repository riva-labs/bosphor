/**
 * e2e-priced.ts
 *
 * HITL end-to-end verification of the M4 priced payment round-trip against the
 * deployed BosphorEscrowAdapter. Not run in CI; needs live testnet infra (a
 * deployed escrow adapter, a running relayer with the /quote endpoint, Sui/Walrus).
 *
 * Happy path: SDK storePriced() fetches the all-in quote, pays escrow + LZ fee at
 * submit, uploads, and awaits the proof; we assert the on-chain escrow went
 * Pending -> Released and the relayer beneficiary is credited.
 *
 * Refund path: submit a priced intent with a near-past deadline, do NOT store it,
 * then after the deadline call refund() and assert the payer is credited.
 *
 * Usage: BOSPHOR_ENV_FILE=relayer/.env.testnet npm run test:e2e:priced
 * Required env: EVM_RPC_URL, EVM_ESCROW_ADAPTER_ADDRESS (or EVM_ADAPTER_ADDRESS),
 *               EVM_RELAYER_KEY, RELAYER_URL
 */
import { config } from "dotenv";
import { resolve } from "path";
config({
  path: process.env.BOSPHOR_ENV_FILE
    ? resolve(process.env.BOSPHOR_ENV_FILE)
    : resolve(import.meta.dirname, "../../.env"),
});

import { ethers } from "ethers";
import { createBosphorClient, defaultComputeBlob, type Hex } from "../../sdk/src/evm/index.ts";

const EVM_RPC_URL = process.env.EVM_RPC_URL!;
const ADAPTER_ADDRESS = process.env.EVM_ESCROW_ADAPTER_ADDRESS || process.env.EVM_ADAPTER_ADDRESS!;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY!;
const RELAYER_URL = process.env.RELAYER_URL || "http://localhost:3000";
const DST_EID = Number(process.env.SUI_EID) || 40378;
const STORAGE_EPOCHS = Number(process.env.WALRUS_STORE_EPOCHS) || 5;
const LZ_OPTIONS = process.env.LZ_OPTIONS || "0x00030100110100000000000000000000000000030d40";

if (!EVM_RPC_URL || !ADAPTER_ADDRESS || !EVM_RELAYER_KEY) {
  console.error("Missing EVM_RPC_URL / EVM_ESCROW_ADAPTER_ADDRESS / EVM_RELAYER_KEY");
  process.exit(1);
}

const ESCROW_ABI = [
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)",
  "event IntentExecuted(bytes32 indexed intentId, bytes proof)",
  "function executed(bytes32) view returns (bool)",
  "function committedBlobId(bytes32) view returns (bytes32)",
  "function nonces(address) view returns (uint256)",
  "function quote(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function submitIntent(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) payable returns (bytes32)",
  "function refund(bytes32) external",
  "function withdraw() external",
  "function withdrawable(address) view returns (uint256)",
  "function trustedRelayer() view returns (address)",
  "function getEscrow(bytes32) view returns (tuple(address payer, address token, uint256 amount, uint64 deadline, uint8 status))",
];

const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
const wallet = new ethers.Wallet(EVM_RELAYER_KEY, provider);
const adapter = new ethers.Contract(ADAPTER_ADDRESS, ESCROW_ABI, wallet);
(adapter as unknown as { queryProof?: unknown }).queryProof = async (intentId: Hex) => {
  const logs = await adapter.queryFilter(adapter.filters.IntentExecuted(intentId));
  const last = logs[logs.length - 1];
  return last ? ((adapter.interface.parseLog(last)?.args?.proof as Hex) ?? null) : null;
};

const bosphor = createBosphorClient({
  adapter: adapter as unknown as Parameters<typeof createBosphorClient>[0]["adapter"],
  relayerUrl: RELAYER_URL,
  dstEid: DST_EID,
  options: LZ_OPTIONS as `0x${string}`,
  defaultEpochs: STORAGE_EPOCHS,
  computeBlob: defaultComputeBlob,
});

async function happyPath(): Promise<void> {
  console.log("\n=== Priced happy path (storePriced) ===");
  const data = ethers.toUtf8Bytes(`bosphor-m4-priced-${Date.now()}`);
  const result = await bosphor.storePriced(data, { epochs: STORAGE_EPOCHS });
  console.log(`  intentId: ${result.intentId}`);
  console.log(`  quote:    escrow ${result.quote.escrowNative} wei ($${result.quote.breakdown.escrowUsd.toFixed(4)})`);

  const relayerAddr: string = await adapter.trustedRelayer();
  const escrow = await adapter.getEscrow(result.intentId);
  const withdrawable: bigint = await adapter.withdrawable(relayerAddr);
  console.log(`  escrow status: ${escrow.status} (2 = Released expected)`);
  console.log(`  relayer withdrawable: ${withdrawable} wei`);

  if (Number(escrow.status) !== 2) throw new Error("escrow was not Released on proof");
  if (withdrawable <= 0n) throw new Error("relayer was not credited on release");
  console.log("  [OK] proof released the escrow to the relayer");
}

async function refundPath(): Promise<void> {
  console.log("\n=== Refund path (no proof, deadline passes) ===");
  const shortDeadline = Math.floor(Date.now() / 1000) + 60; // 60s
  const encoded = await bosphor.encode(ethers.toUtf8Bytes(`refund-${Date.now()}`), {
    epochs: STORAGE_EPOCHS,
    deadline: BigInt(shortDeadline),
  });
  const quote = await bosphor.priceQuote(encoded);
  const { intentId } = await bosphor.submitPaid(encoded, quote);
  console.log(`  submitted (not stored): ${intentId}, escrow ${quote.escrowNative} wei`);

  console.log("  waiting for the deadline to pass...");
  await new Promise((r) => setTimeout(r, 65_000));

  const payerBefore: bigint = await adapter.withdrawable(wallet.address);
  await (await adapter.refund(intentId)).wait();
  const payerAfter: bigint = await adapter.withdrawable(wallet.address);
  console.log(`  payer withdrawable: ${payerBefore} -> ${payerAfter} wei`);

  if (payerAfter - payerBefore !== quote.escrowNative) {
    throw new Error("refund did not credit the payer the full escrow");
  }
  console.log("  [OK] deadline refund returned the escrow to the payer");
}

async function main(): Promise<void> {
  console.log("=== Bosphor M4 priced e2e ===");
  console.log(`  adapter:  ${ADAPTER_ADDRESS}`);
  console.log(`  relayer:  ${RELAYER_URL}`);
  await happyPath();
  await refundPath();
  console.log("\n=== M4 priced e2e complete ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
