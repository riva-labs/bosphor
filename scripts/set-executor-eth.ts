import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { bcs } from "@mysten/sui/bcs";

const suiClient = new SuiClient({ url: process.env.SUI_RPC_URL! });
const { secretKey } = decodeSuiPrivateKey(process.env.SUI_DEPLOYER_KEY!);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);

const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const ADMIN_CAP = process.env.SUI_LZ_ADMIN_CAP_ID!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
const LZ_EXECUTOR = process.env.SUI_LZ_EXECUTOR_PKG!;
const EVM_EID = Number(process.env.EVM_EID); // 30101

function encodeExecutorConfig(maxMessageSize: bigint, executor: string): Uint8Array {
  const ExecutorConfig = bcs.struct("ExecutorConfig", {
    max_message_size: bcs.u64(),
    executor: bcs.Address,
  });
  return ExecutorConfig.serialize({ max_message_size: maxMessageSize, executor }).toBytes();
}

async function main() {
  console.log(`Setting executor config on Sui for EVM EID ${EVM_EID}`);
  console.log(`  Executor: ${LZ_EXECUTOR}`);

  const tx = new Transaction();
  const execConfig = encodeExecutorConfig(10000n, LZ_EXECUTOR);
  const [call] = tx.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx.object(OAPP_ID), tx.object(ADMIN_CAP), tx.object(LZ_ENDPOINT_OBJ),
      tx.pure.address(ULN302), tx.pure.u32(EVM_EID), tx.pure.u32(1),
      tx.pure("vector<u8>", Array.from(execConfig)),
    ],
  });
  tx.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx.object(ULN302_OBJ), call] });

  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });
  if (result.effects?.status?.status !== "success") {
    console.error("FAILED:", result.effects?.status);
    process.exit(1);
  }
  console.log(`[OK] set_executor_config: ${result.digest}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
