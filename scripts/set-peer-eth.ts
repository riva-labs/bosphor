import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname || ".", "/home/arb/bosphor/.env") });

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

const SUI_RPC_URL = process.env.SUI_RPC_URL!;
const suiClient = new SuiClient({ url: SUI_RPC_URL });

const { secretKey } = decodeSuiPrivateKey(process.env.SUI_DEPLOYER_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const ADMIN_CAP = process.env.SUI_LZ_ADMIN_CAP_ID!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const MESSAGING_CHANNEL = process.env.SUI_LZ_MESSAGING_CHANNEL!;
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const BYTES32_PKG = process.env.SUI_LZ_BYTES32_PKG!;
const EVM_ADAPTER = process.env.EVM_ADAPTER_ADDRESS!;
const EVM_EID = Number(process.env.EVM_EID); // 30101

function addressToBytes32(addr: string): number[] {
  const clean = addr.replace("0x", "").toLowerCase().padStart(64, "0");
  const bytes: number[] = [];
  for (let i = 0; i < 64; i += 2) {
    bytes.push(parseInt(clean.substring(i, i + 2), 16));
  }
  return bytes;
}

async function main() {
  console.log(`Setting peer on Sui OApp for EVM EID ${EVM_EID}`);
  console.log(`  Adapter: ${EVM_ADAPTER}`);
  console.log(`  OApp: ${OAPP_ID}`);

  const tx = new Transaction();
  const [peerBytes32] = tx.moveCall({
    target: `${BYTES32_PKG}::bytes32::from_bytes`,
    arguments: [tx.pure("vector<u8>", addressToBytes32(EVM_ADAPTER))],
  });
  tx.moveCall({
    target: `${OAPP_PKG}::oapp::set_peer`,
    arguments: [
      tx.object(OAPP_ID), tx.object(ADMIN_CAP), tx.object(LZ_ENDPOINT_OBJ),
      tx.object(MESSAGING_CHANNEL), tx.pure.u32(EVM_EID), peerBytes32,
    ],
  });

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status !== "success") {
    console.error("FAILED:", result.effects?.status);
    process.exit(1);
  }
  console.log(`[OK] set_peer: ${result.digest}`);
  await suiClient.waitForTransaction({ digest: result.digest });
}

main().catch(console.error);
