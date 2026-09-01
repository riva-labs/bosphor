/**
 * submit-intent-only.ts (ad hoc evidence tool for issue #337)
 *
 * Submits one intent commitment to the EVM adapter WITHOUT delivering the blob
 * bytes to the relayer. This keeps the fallback-capable relayer image out of
 * the return leg so the LayerZero return path can be exercised end to end in
 * isolation. The intent expires at its deadline on the relayer side.
 *
 * Usage: BOSPHOR_ENV_FILE=... npx tsx scripts/test/submit-intent-only.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({
  path: process.env.BOSPHOR_ENV_FILE
    ? resolve(process.env.BOSPHOR_ENV_FILE)
    : resolve(import.meta.dirname, "../../.env"),
});

import { ethers } from "ethers";
import { createBosphorClient, defaultComputeBlob } from "../../sdk/src/evm/index.ts";

const ADAPTER_ABI = [
  "function nonces(address) view returns (uint256)",
  "function intents(bytes32) view returns (bool)",
  "function getIntentId(address sender, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, uint64 nonce) view returns (bytes32)",
  "function quote(uint32 dstEid, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function submitIntent(uint32 dstEid, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, bytes options) payable returns (bytes32)",
];

const DST_EID = Number(process.env.SUI_EID) || 40378;
const LZ_OPTIONS = process.env.LZ_OPTIONS || "0x00030100110100000000000000000000000000030d40";

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL!, undefined, {
    staticNetwork: true,
  });
  const wallet = new ethers.Wallet(process.env.EVM_RELAYER_KEY!, provider);
  const adapter = new ethers.Contract(process.env.EVM_ADAPTER_ADDRESS!, ADAPTER_ABI, wallet);

  const data = new TextEncoder().encode(`bosphor-337-lz-return-evidence-${Date.now()}`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 minutes

  const bosphor = createBosphorClient({
    adapter: adapter as unknown as Parameters<typeof createBosphorClient>[0]["adapter"],
    relayerUrl: "http://unused.invalid",
    dstEid: DST_EID,
    computeBlob: defaultComputeBlob,
  });
  const encoded = await bosphor.encode(data, { epochs: 5, deadline });
  const nonce = await adapter.nonces(wallet.address);
  const intentId: string = await adapter.getIntentId(
    wallet.address,
    encoded.blobId,
    encoded.size,
    encoded.encodingType,
    encoded.storageEpochs,
    encoded.deadline,
    nonce,
  );
  console.log(`intentId: ${intentId}`);
  console.log(`blobId:   ${encoded.blobId}`);
  console.log(`deadline: ${deadline}`);

  const fee = await adapter.quote(
    DST_EID,
    encoded.blobId,
    encoded.size,
    encoded.encodingType,
    encoded.storageEpochs,
    encoded.deadline,
    LZ_OPTIONS,
  );
  console.log(`lz fee:   ${ethers.formatEther(fee[0])} ETH`);

  const tx = await adapter.submitIntent(
    DST_EID,
    encoded.blobId,
    encoded.size,
    encoded.encodingType,
    encoded.storageEpochs,
    encoded.deadline,
    LZ_OPTIONS,
    { value: fee[0] },
  );
  console.log(`submit tx: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`confirmed in block ${receipt?.blockNumber}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
