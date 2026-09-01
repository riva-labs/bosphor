/**
 * set-lz-relayer.ts
 *
 * Inspect or repair the authorized relayer on the Bosphor LzReceiverConfig.
 * This is the corrective tool for the live follow-up to issue #337: the config
 * initializes `relayer` to ctx.sender() at publish (the deployer), and no
 * deploy step ever ran lz_receiver::set_relayer, so every lz_send_proof signed
 * by the operational relayer key aborted with code 2 (EUnauthorizedRelayer)
 * during transaction resolution.
 *
 * Usage:
 *   npx tsx scripts/util/set-lz-relayer.ts                    # inspect only
 *   npx tsx scripts/util/set-lz-relayer.ts --use-relayer-key  # authorize SUI_RELAYER_KEY's address
 *   npx tsx scripts/util/set-lz-relayer.ts --relayer 0x...    # authorize an explicit address
 *
 * Signs with SUI_DEPLOYER_KEY (the OApp AdminCap holder).
 * Env: same as deploy-sui.ts (BOSPHOR_ENV_FILE respected).
 */
import { config } from "dotenv";
import { resolve } from "path";

const ENV_PATH = process.env.BOSPHOR_ENV_FILE
  ? resolve(process.env.BOSPHOR_ENV_FILE)
  : resolve(import.meta.dirname, "../../.env");
config({ path: ENV_PATH });

import { Transaction } from "@mysten/sui/transactions";
import { createSuiClient, createSuiSigner, signAndExecute } from "./sui-client.js";

const SUI_DEPLOYER_KEY = process.env.SUI_DEPLOYER_KEY;
const SUI_RELAYER_KEY = process.env.SUI_RELAYER_KEY;
const LZ_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID!;
const LZ_CONFIG_ID = process.env.SUI_LZ_CONFIG_ID!;
const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const ADMIN_CAP = process.env.SUI_LZ_ADMIN_CAP_ID!;

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  return {
    useRelayerKey: args.includes("--use-relayer-key"),
    relayer: get("--relayer"),
  };
}

async function readAuthorizedRelayer(client: ReturnType<typeof createSuiClient>) {
  const { response } = await client.ledgerService.getObject({
    objectId: LZ_CONFIG_ID,
    readMask: { paths: ["json"] },
  });
  type ProtoValue = {
    kind?: {
      oneofKind?: string;
      stringValue?: string;
      structValue?: { fields?: Record<string, ProtoValue> };
    };
  };
  const json = response.object?.json as ProtoValue | undefined;
  const field = json?.kind?.oneofKind === "structValue"
    ? json.kind.structValue?.fields?.relayer
    : undefined;
  const relayer = field?.kind?.oneofKind === "stringValue" ? field.kind.stringValue : undefined;
  if (!relayer) {
    throw new Error(`Failed to read the relayer field of LzReceiverConfig ${LZ_CONFIG_ID}`);
  }
  return relayer;
}

async function main() {
  for (const [name, value] of Object.entries({
    SUI_LZ_PACKAGE_ID: LZ_PACKAGE_ID,
    SUI_LZ_CONFIG_ID: LZ_CONFIG_ID,
    SUI_LZ_OAPP_ID: OAPP_ID,
    SUI_LZ_ADMIN_CAP_ID: ADMIN_CAP,
  })) {
    if (!value) throw new Error(`Missing required env: ${name}`);
  }

  const { useRelayerKey, relayer: relayerArg } = parseArgs();
  const client = createSuiClient(process.env.SUI_RPC_URL);

  const authorized = await readAuthorizedRelayer(client);
  console.log(`LzReceiverConfig:    ${LZ_CONFIG_ID}`);
  console.log(`Authorized relayer:  ${authorized}`);

  const operational = SUI_RELAYER_KEY ? createSuiSigner(SUI_RELAYER_KEY).toSuiAddress() : undefined;
  if (operational) {
    const match = operational === authorized;
    console.log(`SUI_RELAYER_KEY:     ${operational} (${match ? "MATCH" : "MISMATCH"})`);
  }

  let target: string | undefined;
  if (relayerArg) target = relayerArg;
  else if (useRelayerKey) {
    if (!operational) throw new Error("--use-relayer-key requires SUI_RELAYER_KEY in the env");
    target = operational;
  }
  if (!target) {
    console.log("\nInspect only. Pass --use-relayer-key or --relayer 0x... to update.");
    return;
  }
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(target)) {
    throw new Error(`Invalid relayer address: ${target}`);
  }
  if (target === authorized) {
    console.log(`\nAlready authorized: ${target}. Nothing to do.`);
    return;
  }
  if (!SUI_DEPLOYER_KEY) {
    throw new Error("Updating requires SUI_DEPLOYER_KEY (the OApp AdminCap holder)");
  }

  const signer = createSuiSigner(SUI_DEPLOYER_KEY);
  console.log(`\nSetting relayer to ${target} (admin ${signer.toSuiAddress()})...`);

  const tx = new Transaction();
  tx.moveCall({
    target: `${LZ_PACKAGE_ID}::lz_receiver::set_relayer`,
    arguments: [
      tx.object(LZ_CONFIG_ID),
      tx.object(ADMIN_CAP),
      tx.object(OAPP_ID),
      tx.pure.address(target),
    ],
  });
  const result = await signAndExecute(client, tx, signer);
  console.log(`set_relayer digest: ${result?.digest}`);

  const after = await readAuthorizedRelayer(client);
  console.log(`Authorized relayer now: ${after} (${after === target ? "OK" : "UNEXPECTED"})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
