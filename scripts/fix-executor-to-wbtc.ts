/**
 * fix-executor-to-wbtc.ts
 *
 * Sets executor config to 0xde7fe... (same as wBTC uses).
 * The executor service identifies itself as this address, not the worker package.
 */
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
const EVM_EID = Number(process.env.EVM_EID); // 30101

// The address the executor service identifies as (same as wBTC config)
const EXECUTOR_IDENTITY = "0xde7fe1a6648d587fcc991f124f3aa5b6389340610804108094d5c5fbf61d1989";

function encodeExecutorConfig(maxMessageSize: bigint, executor: string): Uint8Array {
  const ExecutorConfig = bcs.struct("ExecutorConfig", {
    max_message_size: bcs.u64(),
    executor: bcs.Address,
  });
  return ExecutorConfig.serialize({ max_message_size: maxMessageSize, executor }).toBytes();
}

async function main() {
  console.log("=== Set Executor Config to Match wBTC ===");
  console.log(`  EVM EID: ${EVM_EID}`);
  console.log(`  Executor: ${EXECUTOR_IDENTITY}`);
  console.log();

  const tx = new Transaction();
  const execConfig = encodeExecutorConfig(10000n, EXECUTOR_IDENTITY);
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
    signer: keypair, transaction: tx,
    options: { showEffects: true },
  });
  if (result.effects?.status?.status !== "success") {
    console.error("FAILED:", result.effects?.status);
    process.exit(1);
  }
  console.log(`[OK] Executor config set: ${result.digest}`);

  // Verify
  const verifyTx = new Transaction();
  verifyTx.moveCall({
    target: `${ULN302}::uln_302::get_effective_executor_config`,
    arguments: [verifyTx.object(ULN302_OBJ), verifyTx.pure.address(process.env.SUI_LZ_PACKAGE_ID!), verifyTx.pure.u32(EVM_EID)],
  });
  const verifyResult = await suiClient.devInspectTransactionBlock({
    transactionBlock: verifyTx, sender: keypair.toSuiAddress(),
  });
  const bytes: number[] = verifyResult.results?.[0]?.returnValues?.[0]?.[0] as number[];
  if (bytes && bytes.length >= 40) {
    const executor = "0x" + Array.from(bytes.slice(8, 40)).map(b => b.toString(16).padStart(2, "0")).join("");
    console.log(`[VERIFY] Executor now: ${executor}`);
  }
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
