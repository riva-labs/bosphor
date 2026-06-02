import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

const suiClient = new SuiClient({ url: process.env.SUI_RPC_URL! });
const { secretKey } = decodeSuiPrivateKey(process.env.SUI_DEPLOYER_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

const ENDPOINT_PKG = process.env.SUI_LZ_ENDPOINT_V2!;
const ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
// From checkpoint: MessagingChannel object ID
const CHANNEL_OBJ = "0x014118af1e0f7aa7117e5bdec853524e7f6cbee25fbfbe95a92979a0e4561281";
const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
const OAPP_PKG = process.env.SUI_LZ_PACKAGE_ID!;
const SRC_EID = 30101;

async function checkNonce(nonce: number) {
  // Check has_payload_hash
  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${ENDPOINT_PKG}::messaging_channel::has_payload_hash`,
    arguments: [tx1.object(CHANNEL_OBJ), tx1.pure.u32(SRC_EID), tx1.pure("vector<u8>", Array.from(Buffer.from("0000000000000000000000003c8b7a1c684dd10aed6bb392651c678f1ce05e10", "hex"))), tx1.pure.u64(nonce)],
  });
  const r1 = await suiClient.devInspectTransactionBlock({ transactionBlock: tx1, sender: keypair.toSuiAddress() });
  const hasHash = r1.results?.[0]?.returnValues?.[0]?.[0]?.[0] === 1;

  // Check verifiable
  const tx2 = new Transaction();
  tx2.moveCall({
    target: `${ULN302}::uln_302::verifiable`,
    arguments: [
      tx2.object(ULN302_OBJ),
      tx2.object(CHANNEL_OBJ),
      tx2.pure.address(OAPP_PKG),
      tx2.pure.u32(SRC_EID),
      tx2.pure.u64(nonce),
    ],
  });
  const r2 = await suiClient.devInspectTransactionBlock({ transactionBlock: tx2, sender: keypair.toSuiAddress() });
  const verifiable = r2.effects?.status?.status === "success";

  console.log(`  Nonce ${nonce}: has_payload_hash=${hasHash}, verifiable=${verifiable}`);
}

async function main() {
  console.log("=== Nonce Status Check ===");
  for (const n of [1, 2, 3, 4]) {
    await checkNonce(n);
  }

  // Also check inbound nonce
  const tx = new Transaction();
  tx.moveCall({
    target: `${ENDPOINT_PKG}::messaging_channel::get_inbound_nonce`,
    arguments: [tx.object(CHANNEL_OBJ), tx.pure.u32(SRC_EID), tx.pure("vector<u8>", Array.from(Buffer.from("0000000000000000000000003c8b7a1c684dd10aed6bb392651c678f1ce05e10", "hex")))],
  });
  const r = await suiClient.devInspectTransactionBlock({ transactionBlock: tx, sender: keypair.toSuiAddress() });
  const bytes = r.results?.[0]?.returnValues?.[0]?.[0] as number[];
  if (bytes) {
    const nonce = bytes.reduce((acc: bigint, b: number, i: number) => acc + BigInt(b) * (2n ** BigInt(i * 8)), 0n);
    console.log(`  inbound_nonce: ${nonce}`);
  }
}

main().catch(console.error);
