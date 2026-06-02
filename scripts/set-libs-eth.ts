import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });

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
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const ULN302 = process.env.SUI_LZ_ULN302!;
const EVM_EID = Number(process.env.EVM_EID); // 30101
const CLOCK = "0x6";

async function exec(tx: Transaction, label: string) {
  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  if (result.effects?.status?.status !== "success") {
    console.error(`[FAIL] ${label}:`, result.effects?.status);
    throw new Error(`${label} failed`);
  }
  console.log(`[OK] ${label}: ${result.digest}`);
  await suiClient.waitForTransaction({ digest: result.digest });
  return result;
}

async function main() {
  console.log(`Setting LZ libraries on Sui for EVM EID ${EVM_EID}`);

  // set_send_library
  const tx1 = new Transaction();
  tx1.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_send_library`,
    arguments: [
      tx1.object(OAPP_ID), tx1.object(ADMIN_CAP), tx1.object(LZ_ENDPOINT_OBJ),
      tx1.pure.u32(EVM_EID), tx1.pure.address(ULN302),
    ],
  });
  await exec(tx1, "set_send_library");

  // set_receive_library
  const tx2 = new Transaction();
  tx2.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_receive_library`,
    arguments: [
      tx2.object(OAPP_ID), tx2.object(ADMIN_CAP), tx2.object(LZ_ENDPOINT_OBJ),
      tx2.pure.u32(EVM_EID), tx2.pure.address(ULN302),
      tx2.pure.u64(0), tx2.object(CLOCK),
    ],
  });
  await exec(tx2, "set_receive_library");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
