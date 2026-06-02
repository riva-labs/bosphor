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

// 3 DVNs from wBTC config (Sui mainnet)
const NETHERMIND = "0x0c12321ebe562b8fb8a74e6d29f144ea199a8f31a4cea3a417ce72477f6dfebb";
const LZ_LABS = "0x52aa129049de845353484868d1be6e2df6878b0ed2213d94d3c827309aeae685";
const BITGO = "0x825963b9f56614be069e5bd28e720b9ec00b06dc995cb3ab53708dbb62912367";
const ALL_DVNS = [NETHERMIND, LZ_LABS, BITGO];

function encodeOAppUlnConfig(confirmations: bigint, requiredDvns: string[]): Uint8Array {
  const UlnConfig = bcs.struct("UlnConfig", {
    confirmations: bcs.u64(),
    required_dvns: bcs.vector(bcs.Address),
    optional_dvns: bcs.vector(bcs.Address),
    optional_dvn_threshold: bcs.u8(),
  });
  const OAppUlnConfig = bcs.struct("OAppUlnConfig", {
    use_default_confirmations: bcs.bool(),
    use_default_required_dvns: bcs.bool(),
    use_default_optional_dvns: bcs.bool(),
    uln_config: UlnConfig,
  });
  return OAppUlnConfig.serialize({
    use_default_confirmations: false,
    use_default_required_dvns: false,
    use_default_optional_dvns: true,
    uln_config: { confirmations, required_dvns: requiredDvns, optional_dvns: [], optional_dvn_threshold: 0 },
  }).toBytes();
}

async function exec(tx: Transaction, label: string) {
  const result = await suiClient.signAndExecuteTransaction({
    signer: keypair, transaction: tx,
    options: { showEffects: true },
  });
  if (result.effects?.status?.status !== "success") {
    console.error(`[FAIL] ${label}:`, result.effects?.status);
    throw new Error(`${label} failed`);
  }
  console.log(`[OK] ${label}: ${result.digest}`);
  await suiClient.waitForTransaction({ digest: result.digest });
}

async function main() {
  console.log(`Matching wBTC DVN config on Sui for EVM EID ${EVM_EID}`);
  console.log(`  DVNs: Nethermind, LZ Labs, BitGo`);

  // Receive ULN config (type 3) - 15 confirmations, 3 DVNs
  console.log("\nSetting receive ULN (15 conf, 3 DVNs)...");
  const tx1 = new Transaction();
  const recvConfig = encodeOAppUlnConfig(15n, ALL_DVNS);
  const [call1] = tx1.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx1.object(OAPP_ID), tx1.object(ADMIN_CAP), tx1.object(LZ_ENDPOINT_OBJ),
      tx1.pure.address(ULN302), tx1.pure.u32(EVM_EID), tx1.pure.u32(3),
      tx1.pure("vector<u8>", Array.from(recvConfig)),
    ],
  });
  tx1.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx1.object(ULN302_OBJ), call1] });
  await exec(tx1, "set_receive_uln_config (15 conf, 3 DVNs)");

  // Send ULN config (type 2) - 5 confirmations, 3 DVNs
  console.log("\nSetting send ULN (5 conf, 3 DVNs)...");
  const tx2 = new Transaction();
  const sendConfig = encodeOAppUlnConfig(5n, ALL_DVNS);
  const [call2] = tx2.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx2.object(OAPP_ID), tx2.object(ADMIN_CAP), tx2.object(LZ_ENDPOINT_OBJ),
      tx2.pure.address(ULN302), tx2.pure.u32(EVM_EID), tx2.pure.u32(2),
      tx2.pure("vector<u8>", Array.from(sendConfig)),
    ],
  });
  tx2.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx2.object(ULN302_OBJ), call2] });
  await exec(tx2, "set_send_uln_config (5 conf, 3 DVNs)");

  console.log("\nDone! Sui DVN config matches wBTC.");
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
