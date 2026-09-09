/**
 * inspect-sui-send-config.ts (read-only)
 *
 * Prints the OApp's EFFECTIVE Sui send-side config (send-ULN required DVNs +
 * executor) for one or more dstEids, plus the CallCap identities of our DVN /
 * executor worker objects. Use it to see exactly what the working EVM lane
 * (40161) has that the Solana lane (40168) is missing, so the return path's
 * `lz_send_proof(40168)` can pass the relayer's assertSendPathConfig.
 *
 *   BOSPHOR_ENV_FILE=relayer/.env.testnet npx tsx scripts/util/inspect-sui-send-config.ts
 *   BOSPHOR_ENV_FILE=relayer/.env.testnet npx tsx scripts/util/inspect-sui-send-config.ts 40161 40168
 *
 * Env (same as set-executor-config.ts): SUI_DEPLOYER_KEY, SUI_LZ_ULN302,
 *   SUI_LZ_ULN302_OBJ, SUI_LZ_PACKAGE_ID, SUI_LZ_EXECUTOR_OBJ, SUI_LZ_DVN_OBJ,
 *   optional DVN_OBJECT_ID.
 */
import { config } from "dotenv";
import { resolve } from "path";

const ENV_PATH = process.env.BOSPHOR_ENV_FILE
  ? resolve(process.env.BOSPHOR_ENV_FILE)
  : resolve(import.meta.dirname, "../../.env");
config({ path: ENV_PATH });

import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import { createSuiClient, createSuiSigner, simulateWithOutputs, getWorkerCapAddress } from "./sui-client.js";

const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
// The ULN keys OApp configs by the packet sender: the OApp's package cap identity.
const OAPP_SENDER = process.env.SUI_LZ_PACKAGE_ID!;
const EXECUTOR_OBJ = process.env.SUI_LZ_EXECUTOR_OBJ!;
const DVN_OBJ = process.env.SUI_LZ_DVN_OBJ!;
const DVN_OBJECT_ID = process.env.DVN_OBJECT_ID;

const ExecutorConfigBcs = bcs.struct("ExecutorConfig", {
  max_message_size: bcs.u64(),
  executor: bcs.Address,
});
const UlnConfigBcs = bcs.struct("UlnConfig", {
  confirmations: bcs.u64(),
  required_dvns: bcs.vector(bcs.Address),
  optional_dvns: bcs.vector(bcs.Address),
  optional_dvn_threshold: bcs.u8(),
});

async function main() {
  const eids = process.argv.slice(2).map(Number).filter(Boolean);
  const dstEids = eids.length ? eids : [40161, 40168];

  const client = createSuiClient();
  const sender = createSuiSigner(process.env.SUI_DEPLOYER_KEY!).toSuiAddress();

  console.log(`Env:         ${ENV_PATH}`);
  console.log(`OApp sender: ${OAPP_SENDER}`);
  console.log(`ULN302 obj:  ${ULN302_OBJ}`);

  const dvnCap = await getWorkerCapAddress(client, DVN_OBJ);
  console.log(`\nWorker CallCap identities (what the send config must reference):`);
  console.log(`  SUI_LZ_DVN_OBJ ${DVN_OBJ}`);
  console.log(`    -> CallCap ${dvnCap}`);
  if (DVN_OBJECT_ID && DVN_OBJECT_ID !== DVN_OBJ) {
    console.log(`  DVN_OBJECT_ID ${DVN_OBJECT_ID}`);
    console.log(`    -> CallCap ${await getWorkerCapAddress(client, DVN_OBJECT_ID)}`);
  }
  const execCap = await getWorkerCapAddress(client, EXECUTOR_OBJ);
  console.log(`  SUI_LZ_EXECUTOR_OBJ ${EXECUTOR_OBJ}`);
  console.log(`    -> CallCap ${execCap}`);

  for (const dstEid of dstEids) {
    console.log(`\n=== dstEid ${dstEid} ===`);
    try {
      const tx = new Transaction();
      tx.moveCall({
        target: `${ULN302}::uln_302::get_effective_executor_config`,
        arguments: [tx.object(ULN302_OBJ), tx.pure.address(OAPP_SENDER), tx.pure.u32(dstEid)],
      });
      tx.moveCall({
        target: `${ULN302}::uln_302::get_effective_send_uln_config`,
        arguments: [tx.object(ULN302_OBJ), tx.pure.address(OAPP_SENDER), tx.pure.u32(dstEid)],
      });
      const outputs = await simulateWithOutputs(client, tx, sender);
      const execBytes = outputs[0]?.returnValues?.[0]?.value?.value;
      const ulnBytes = outputs[1]?.returnValues?.[0]?.value?.value;
      if (!execBytes || !ulnBytes) {
        console.log("  (no effective config returned - likely unconfigured for this eid)");
        continue;
      }
      const exec = ExecutorConfigBcs.parse(Uint8Array.from(execBytes));
      const uln = UlnConfigBcs.parse(Uint8Array.from(ulnBytes));
      const dvnMatch = uln.required_dvns.length === 1 && BigInt(uln.required_dvns[0]) === BigInt(dvnCap);
      const execMatch = BigInt(exec.executor) === BigInt(execCap);
      console.log(`  executor:         ${exec.executor}  ${execMatch ? "[= our executor cap]" : "[MISMATCH]"}`);
      console.log(`  max_message_size: ${exec.max_message_size}`);
      console.log(`  confirmations:    ${uln.confirmations}`);
      console.log(`  required_dvns:    ${uln.required_dvns.join(", ") || "(none)"}  ${dvnMatch ? "[= our dvn cap]" : "[MISMATCH]"}`);
      console.log(`  optional_dvns:    ${uln.optional_dvns.join(", ") || "(none)"}`);
      console.log(`  send-path OK for relayer: ${dvnMatch && execMatch && uln.optional_dvns.length === 0}`);
    } catch (e: any) {
      console.log(`  ERROR: ${e.message ?? e}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
