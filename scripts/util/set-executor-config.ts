/**
 * set-executor-config.ts
 *
 * Inspect or repair the OApp-specific executor config on the Sui ULN302 send
 * side. This is the corrective tool for issue #337: the deploy script used to
 * pin the executor config to SUI_LZ_EXECUTOR_PKG (a package id), but the ULN
 * records that address as the callee of the executor child call, and the
 * executor worker authenticates with its CallCap identity (the worker's
 * original package address). The mismatch made every lz_send_proof quote and
 * send abort in call::new_child_batch with code 10 (EUnauthorized).
 *
 * Usage:
 *   npx tsx scripts/util/set-executor-config.ts                     # inspect only
 *   npx tsx scripts/util/set-executor-config.ts --use-default       # zeros: inherit ULN defaults (self-heals)
 *   npx tsx scripts/util/set-executor-config.ts --resolve           # pin the cap of SUI_LZ_EXECUTOR_OBJ
 *   npx tsx scripts/util/set-executor-config.ts --executor 0x... [--max-size 10000]
 *
 * Env: same as deploy-sui.ts (BOSPHOR_ENV_FILE respected).
 */
import { config } from "dotenv";
import { resolve } from "path";

const ENV_PATH = process.env.BOSPHOR_ENV_FILE
  ? resolve(process.env.BOSPHOR_ENV_FILE)
  : resolve(import.meta.dirname, "../../.env");
config({ path: ENV_PATH });

import { Transaction } from "@mysten/sui/transactions";
import { bcs } from "@mysten/sui/bcs";
import {
  createSuiClient,
  createSuiSigner,
  signAndExecute,
  simulateWithOutputs,
  getWorkerCapAddress,
} from "./sui-client.js";

const SUI_DEPLOYER_KEY = process.env.SUI_DEPLOYER_KEY!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const ADMIN_CAP = process.env.SUI_LZ_ADMIN_CAP_ID!;
const EXECUTOR_OBJ = process.env.SUI_LZ_EXECUTOR_OBJ!;
const LZ_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID!;
const EVM_EID = Number(process.env.EVM_EID) || 40161;

const ExecutorConfigBcs = bcs.struct("ExecutorConfig", {
  max_message_size: bcs.u64(),
  executor: bcs.Address,
});

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    useDefault: args.includes("--use-default"),
    resolveCap: args.includes("--resolve"),
    executor: get("--executor"),
    maxSize: BigInt(get("--max-size") ?? "10000"),
  };
}

async function main() {
  const required = {
    SUI_DEPLOYER_KEY,
    SUI_LZ_ENDPOINT_V2_OBJ: LZ_ENDPOINT_OBJ,
    SUI_LZ_OAPP_PKG: OAPP_PKG,
    SUI_LZ_ULN302: ULN302,
    SUI_LZ_ULN302_OBJ: ULN302_OBJ,
    SUI_LZ_OAPP_ID: OAPP_ID,
    SUI_LZ_ADMIN_CAP_ID: ADMIN_CAP,
    SUI_LZ_EXECUTOR_OBJ: EXECUTOR_OBJ,
    SUI_LZ_PACKAGE_ID: LZ_PACKAGE_ID,
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v) {
      console.error(`Missing ${k} in ${ENV_PATH}`);
      process.exit(1);
    }
  }

  const opts = parseArgs();
  const client = createSuiClient();
  const keypair = createSuiSigner(SUI_DEPLOYER_KEY);
  const sender = keypair.toSuiAddress();

  // The ULN keys OApp configs by the packet sender: the OApp's package cap
  // identity, which for the Bosphor lz-receiver is the package address.
  const oappSender = LZ_PACKAGE_ID;

  console.log(`Env file:       ${ENV_PATH}`);
  console.log(`Signer:         ${sender}`);
  console.log(`OApp sender:    ${oappSender}`);
  console.log(`Dst EID:        ${EVM_EID}`);

  // Current effective config + the executor worker's true identity.
  const inspectTx = new Transaction();
  inspectTx.moveCall({
    target: `${ULN302}::uln_302::get_effective_executor_config`,
    arguments: [
      inspectTx.object(ULN302_OBJ),
      inspectTx.pure.address(oappSender),
      inspectTx.pure.u32(EVM_EID),
    ],
  });
  const outputs = await simulateWithOutputs(client, inspectTx, sender);
  const effectiveBytes = outputs[0]?.returnValues?.[0]?.value?.value;
  if (!effectiveBytes) throw new Error("Failed to read the effective executor config");
  const effective = ExecutorConfigBcs.parse(Uint8Array.from(effectiveBytes));
  const workerCap = await getWorkerCapAddress(client, EXECUTOR_OBJ);

  console.log(`\nEffective executor config:`);
  console.log(`  max_message_size: ${effective.max_message_size}`);
  console.log(`  executor:         ${effective.executor}`);
  console.log(`Executor object ${EXECUTOR_OBJ}`);
  console.log(`  CallCap identity: ${workerCap}`);
  const matches = BigInt(effective.executor) === BigInt(workerCap);
  console.log(`  Match:            ${matches ? "OK" : "MISMATCH (lz_send_proof will abort)"}`);

  let newConfig: { max_message_size: bigint; executor: string } | undefined;
  if (opts.useDefault) {
    // Zero values mean "inherit the ULN default" in the effective-config
    // merge, so this self-heals across LZ executor rotations.
    newConfig = { max_message_size: 0n, executor: "0x" + "0".repeat(64) };
  } else if (opts.resolveCap) {
    newConfig = { max_message_size: opts.maxSize, executor: workerCap };
  } else if (opts.executor) {
    newConfig = { max_message_size: opts.maxSize, executor: opts.executor };
  }

  if (!newConfig) {
    console.log(`\nInspect only. Pass --use-default, --resolve, or --executor to write.`);
    return;
  }

  console.log(`\nSetting OApp executor config (type 1):`);
  console.log(`  max_message_size: ${newConfig.max_message_size}`);
  console.log(`  executor:         ${newConfig.executor}`);

  const configBytes = ExecutorConfigBcs.serialize(newConfig).toBytes();
  const tx = new Transaction();
  const [call] = tx.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx.object(OAPP_ID),
      tx.object(ADMIN_CAP),
      tx.object(LZ_ENDPOINT_OBJ),
      tx.pure.address(ULN302),
      tx.pure.u32(EVM_EID),
      tx.pure.u32(1),
      tx.pure("vector<u8>", Array.from(configBytes)),
    ],
  });
  tx.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx.object(ULN302_OBJ), call] });

  const result = await signAndExecute(client, tx, keypair);
  if (!result?.effects?.status?.success) {
    throw new Error(`set_config failed: ${JSON.stringify(result?.effects?.status)}`);
  }
  console.log(`\n[OK] set_executor_config TX: ${result.digest}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
