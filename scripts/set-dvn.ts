/**
 * set-dvn.ts
 *
 * Updates the required DVN configuration on both EVM and Sui sides
 * to use the LayerZero Labs DVN.
 *
 * Usage: npx tsx scripts/set-dvn.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(import.meta.dirname, "../.env") });

import { ethers } from "ethers";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { bcs } from "@mysten/sui/bcs";

// --- DVN addresses (from .env) ---
if (!process.env.EVM_DVN_ADDRESS || !process.env.SUI_DVN_ADDRESS) {
  console.error("Missing EVM_DVN_ADDRESS or SUI_DVN_ADDRESS in .env");
  process.exit(1);
}
const LZ_LABS_DVN_ETH = process.env.EVM_DVN_ADDRESS;
const LZ_LABS_DVN_SUI = process.env.SUI_DVN_ADDRESS;

// --- EVM config ---
const EVM_RPC_URL = process.env.EVM_RPC_URL!;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY!;
const LZ_ENDPOINT = process.env.LZ_ENDPOINT_ADDRESS!;
const EVM_ADAPTER = process.env.EVM_ADAPTER_ADDRESS!;
const SUI_EID = Number(process.env.SUI_EID) || 40378;

// --- Sui config ---
const SUI_RPC_URL = process.env.SUI_RPC_URL!;
const SUI_DEPLOYER_KEY = process.env.SUI_DEPLOYER_KEY!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;
const OAPP_PKG = process.env.SUI_LZ_OAPP_PKG!;
const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
const OAPP_ID = process.env.SUI_LZ_OAPP_ID!;
const ADMIN_CAP = process.env.SUI_LZ_ADMIN_CAP_ID!;
const EVM_EID = Number(process.env.EVM_EID) || 40161;

// --- BCS encoding ---
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

// --- EVM: setConfig on EndpointV2 ---
async function updateEvmDvn() {
  console.log("\n=== EVM: Update DVN to LayerZero Labs ===");
  console.log(`  Endpoint: ${LZ_ENDPOINT}`);
  console.log(`  Adapter:  ${EVM_ADAPTER}`);
  console.log(`  DVN:      ${LZ_LABS_DVN_ETH}`);
  console.log(`  Dst EID:  ${SUI_EID}`);

  const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(EVM_RELAYER_KEY, provider);

  const endpointAbi = [
    "function setConfig(address _oapp, address _lib, tuple(uint32 eid, uint32 configType, bytes config)[] _params) external",
    "function getSendLibrary(address _sender, uint32 _eid) view returns (address)",
    "function getReceiveLibrary(address _receiver, uint32 _eid) view returns (address, bool)",
  ];
  const endpoint = new ethers.Contract(LZ_ENDPOINT, endpointAbi, wallet);

  // Get the send and receive library addresses
  const sendLib = await endpoint.getSendLibrary(EVM_ADAPTER, SUI_EID);
  const [receiveLib] = await endpoint.getReceiveLibrary(EVM_ADAPTER, SUI_EID);
  console.log(`  SendLib:    ${sendLib}`);
  console.log(`  ReceiveLib: ${receiveLib}`);

  // UlnConfig struct: (uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount, uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)
  // CONFIG_TYPE_ULN = 2
  const configType = 2;

  // Send config: EVM -> Sui (forward path), confirmations = 2
  const sendUlnConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint64, uint8, uint8, uint8, address[], address[])"],
    [[2n, 1, 0, 0, [LZ_LABS_DVN_ETH], []]]
  );

  console.log("\n  Setting send ULN config (confirmations=2)...");
  const sendTx = await endpoint.setConfig(
    EVM_ADAPTER,
    sendLib,
    [{ eid: SUI_EID, configType, config: sendUlnConfig }]
  );
  await sendTx.wait();
  console.log(`  [OK] Send config TX: ${sendTx.hash}`);

  // Receive config: Sui -> EVM (return path), confirmations = 1
  // Sui testnet DVN does not reliably handle confirmations > 1 for
  // Sui's checkpoint-based finality model. Outbound (Sui send = 2) >=
  // inbound (EVM recv = 1) satisfies the LZ constraint.
  const recvUlnConfig = ethers.AbiCoder.defaultAbiCoder().encode(
    ["tuple(uint64, uint8, uint8, uint8, address[], address[])"],
    [[1n, 1, 0, 0, [LZ_LABS_DVN_ETH], []]]
  );

  console.log("  Setting receive ULN config (confirmations=1)...");
  const recvTx = await endpoint.setConfig(
    EVM_ADAPTER,
    receiveLib,
    [{ eid: SUI_EID, configType, config: recvUlnConfig }]
  );
  await recvTx.wait();
  console.log(`  [OK] Receive config TX: ${recvTx.hash}`);
}

// --- Sui: set_config ---
async function updateSuiDvn() {
  console.log("\n=== Sui: Update DVN to LayerZero Labs ===");
  console.log(`  OApp:     ${OAPP_ID}`);
  console.log(`  AdminCap: ${ADMIN_CAP}`);
  console.log(`  DVN:      ${LZ_LABS_DVN_SUI}`);
  console.log(`  Dst EID:  ${EVM_EID}`);

  const suiClient = new SuiClient({ url: SUI_RPC_URL });
  const { secretKey } = decodeSuiPrivateKey(SUI_DEPLOYER_KEY);
  const keypair = Ed25519Keypair.fromSecretKey(secretKey);
  console.log(`  Deployer: ${keypair.toSuiAddress()}`);

  async function exec(tx: Transaction, label: string) {
    const result = await suiClient.signAndExecuteTransaction({
      signer: keypair,
      transaction: tx,
      options: { showEffects: true },
    });
    if (result.effects?.status?.status !== "success") {
      console.error(`  [FAIL] ${label}:`, result.effects?.status);
      throw new Error(`${label} failed`);
    }
    console.log(`  [OK] ${label}: ${result.digest}`);
    await suiClient.waitForTransaction({ digest: result.digest });
    return result;
  }

  // Receive ULN config (type 3) - for messages coming FROM EVM
  const tx1 = new Transaction();
  const recvConfig = encodeOAppUlnConfig(2n, [LZ_LABS_DVN_SUI]);
  const [call1] = tx1.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx1.object(OAPP_ID), tx1.object(ADMIN_CAP), tx1.object(LZ_ENDPOINT_OBJ),
      tx1.pure.address(ULN302), tx1.pure.u32(EVM_EID), tx1.pure.u32(3),
      tx1.pure("vector<u8>", Array.from(recvConfig)),
    ],
  });
  tx1.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx1.object(ULN302_OBJ), call1] });
  await exec(tx1, "set_receive_uln_config (LayerZero Labs)");

  // Send ULN config (type 2) - for messages going TO EVM (return path)
  // Confirmations = 1 to match EVM receive side. Sui checkpoint finality
  // is near-instant, so 1 confirmation is sufficient.
  const tx2 = new Transaction();
  const sendConfig = encodeOAppUlnConfig(1n, [LZ_LABS_DVN_SUI]);
  const [call2] = tx2.moveCall({
    target: `${OAPP_PKG}::endpoint_calls::set_config`,
    arguments: [
      tx2.object(OAPP_ID), tx2.object(ADMIN_CAP), tx2.object(LZ_ENDPOINT_OBJ),
      tx2.pure.address(ULN302), tx2.pure.u32(EVM_EID), tx2.pure.u32(2),
      tx2.pure("vector<u8>", Array.from(sendConfig)),
    ],
  });
  tx2.moveCall({ target: `${ULN302}::uln_302::set_config`, arguments: [tx2.object(ULN302_OBJ), call2] });
  await exec(tx2, "set_send_uln_config (LayerZero Labs)");
}

async function main() {
  console.log("========================================");
  console.log("  DVN Config Update: LayerZero Labs");
  console.log("========================================");

  await updateEvmDvn();
  await updateSuiDvn();

  console.log("\n========================================");
  console.log("  DVN Update Complete!");
  console.log("  Base DVN:  " + LZ_LABS_DVN_ETH);
  console.log("  Sui DVN:   " + LZ_LABS_DVN_SUI);
  console.log("========================================");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
