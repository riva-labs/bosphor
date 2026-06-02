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
const sender = keypair.toSuiAddress();

const EXEC_PKG = process.env.SUI_LZ_EXECUTOR_PKG!;
const EXEC_OBJ = process.env.SUI_LZ_EXECUTOR_OBJ!;
const OUR_PACKAGE = process.env.SUI_LZ_PACKAGE_ID!;
const OUR_OAPP = process.env.SUI_LZ_OAPP_ID!;
const ULN302 = process.env.SUI_LZ_ULN302!;

async function query(label: string, fn: string, extraArgs: string[] = []) {
  const tx = new Transaction();
  const args: any[] = [tx.object(EXEC_OBJ), ...extraArgs.map(a => tx.pure.address(a))];
  tx.moveCall({ target: `${EXEC_PKG}::executor_worker::${fn}`, arguments: args });
  try {
    const result = await suiClient.devInspectTransactionBlock({ transactionBlock: tx, sender });
    if (result.effects?.status?.status !== "success") {
      console.log(`  ${label}: FAIL`);
      return;
    }
    const rv = result.results?.[0]?.returnValues?.[0]?.[0];
    if (rv) {
      if (rv.length === 1) console.log(`  ${label}: ${rv[0] === 1}`);
      else if (rv.length <= 8) {
        const n = Number(BigInt(rv[0]) | (BigInt(rv[1] || 0) << 8n) | (BigInt(rv[2] || 0) << 16n) | (BigInt(rv[3] || 0) << 24n));
        console.log(`  ${label}: ${n}`);
      } else {
        console.log(`  ${label}: ${rv.length} bytes`);
      }
    }
  } catch (e: any) {
    console.log(`  ${label}: ERROR - ${e.message?.slice(0, 100)}`);
  }
}

async function main() {
  console.log("=== Executor Diagnostics ===");
  console.log(`  Executor PKG: ${EXEC_PKG}`);
  console.log(`  Executor OBJ: ${EXEC_OBJ}`);
  console.log(`  Our Package:  ${OUR_PACKAGE}`);
  console.log(`  Our OApp:     ${OUR_OAPP}`);
  console.log();

  await query("allowlist_size", "allowlist_size");
  await query("is_allowlisted(package)", "is_allowlisted", [OUR_PACKAGE]);
  await query("is_allowlisted(oapp)", "is_allowlisted", [OUR_OAPP]);
  await query("is_denylisted(package)", "is_denylisted", [OUR_PACKAGE]);
  await query("is_denylisted(oapp)", "is_denylisted", [OUR_OAPP]);
  await query("is_paused", "is_paused");
  await query("is_supported_lib(uln302)", "is_supported_message_lib", [ULN302]);

  // Check dst_config for Ethereum EID (30101)
  console.log("\n--- Dst Config (EID 30101) ---");
  {
    const tx = new Transaction();
    tx.moveCall({
      target: `${EXEC_PKG}::executor_worker::dst_config`,
      arguments: [tx.object(EXEC_OBJ), tx.pure.u32(30101)],
    });
    try {
      const result = await suiClient.devInspectTransactionBlock({ transactionBlock: tx, sender });
      if (result.effects?.status?.status !== "success") {
        console.log("  dst_config(30101): FAIL");
      } else {
        const rv = result.results?.[0]?.returnValues;
        if (rv) {
          for (let i = 0; i < rv.length; i++) {
            console.log(`  dst_config return ${i}: ${rv[i][0].length} bytes = ${Array.from(rv[i][0]).map((b: number) => b.toString(16).padStart(2, '0')).join('')}`);
          }
        }
      }
    } catch (e: any) {
      console.log(`  dst_config(30101): ERROR - ${e.message?.slice(0, 100)}`);
    }
  }
}

main().catch(console.error);
