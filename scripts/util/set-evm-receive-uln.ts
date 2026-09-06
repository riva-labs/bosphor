/**
 * set-evm-receive-uln.ts
 *
 * Mirrors the EVM receive-ULN config from the OLD BosphorAdapter onto the NEW
 * BosphorEscrowAdapter (M4, #395) so that return proofs (Sui -> Sepolia) are
 * verifiable by our own DVN operator EOA (0x9665...). A freshly deployed adapter
 * has NO messaging config, so the endpoint would fall back to the library
 * default receive-ULN, whose Sui-testnet DVN is the dead LZ-Labs default. This
 * copies the exact required-DVN set the old adapter already uses (proven live by
 * return nonce 1315) onto the new one.
 *
 * The receive-ULN config on EVM is keyed by the SOURCE eid: return proofs
 * originate on Sui, so the eid is SUI_EID (40378), config type 2 (ULN), applied
 * on the receive library (ULN302). The caller must be the new adapter's OApp
 * delegate, which deploy-evm-escrow.ts set to the EVM_RELAYER_KEY address.
 *
 * SAFE BY DEFAULT: inspect + dry-run only. Nothing is broadcast unless --apply
 * is passed. --apply sends one endpoint.setConfig tx from EVM_RELAYER_KEY, then
 * re-reads the new adapter's config and asserts it matches the old one.
 *
 * Usage:
 *   BOSPHOR_ENV_FILE=relayer/.env.testnet npx tsx scripts/util/set-evm-receive-uln.ts
 *   BOSPHOR_ENV_FILE=relayer/.env.testnet npx tsx scripts/util/set-evm-receive-uln.ts --apply
 *
 * Required env: EVM_RPC_URL, EVM_RELAYER_KEY, LZ_ENDPOINT_ADDRESS, SUI_EID,
 *   EVM_ADAPTER_ADDRESS (source/old), EVM_ESCROW_ADAPTER_ADDRESS (target/new)
 * Optional env: EVM_RECEIVE_ULN302 (pin the receive lib instead of resolving it)
 */
import { config } from "dotenv";
import { resolve } from "path";

const ENV_PATH = process.env.BOSPHOR_ENV_FILE
  ? resolve(process.env.BOSPHOR_ENV_FILE)
  : resolve(import.meta.dirname, "../../.env");
config({ path: ENV_PATH });

import { ethers } from "ethers";

const EVM_RPC_URL = process.env.EVM_RPC_URL!;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY!;
const LZ_ENDPOINT = process.env.LZ_ENDPOINT_ADDRESS || "0x6EDCE65403992e310A62460808c4b910D972f10f";
const OLD_ADAPTER = process.env.EVM_ADAPTER_ADDRESS!;
const NEW_ADAPTER = process.env.EVM_ESCROW_ADAPTER_ADDRESS!;
const SUI_EID = Number(process.env.SUI_EID) || 40378;
const RECEIVE_LIB_OVERRIDE = process.env.EVM_RECEIVE_ULN302;

// LayerZero CONFIG_TYPE_ULN. Executor config is 1; ULN (DVN set) is 2.
const CONFIG_TYPE_ULN = 2;

// UlnConfig ABI layout, per LZ ReceiveUln302:
// (uint64 confirmations, uint8 requiredDVNCount, uint8 optionalDVNCount,
//  uint8 optionalDVNThreshold, address[] requiredDVNs, address[] optionalDVNs)
const ULN_ABI_TUPLE = "tuple(uint64, uint8, uint8, uint8, address[], address[])";

const endpointAbi = [
  "function getConfig(address _oapp, address _lib, uint32 _eid, uint32 _configType) view returns (bytes)",
  "function getReceiveLibrary(address _receiver, uint32 _srcEid) view returns (address, bool)",
  "function setConfig(address _oapp, address _lib, tuple(uint32 eid, uint32 configType, bytes config)[] _params) external",
];

function parseArgs() {
  const args = process.argv.slice(2);
  return { apply: args.includes("--apply") };
}

function requireEnv() {
  const required = {
    EVM_RPC_URL,
    EVM_RELAYER_KEY,
    LZ_ENDPOINT_ADDRESS: LZ_ENDPOINT,
    EVM_ADAPTER_ADDRESS: OLD_ADAPTER,
    EVM_ESCROW_ADAPTER_ADDRESS: NEW_ADAPTER,
  };
  for (const [k, v] of Object.entries(required)) {
    if (!v) {
      console.error(`Missing ${k} in ${ENV_PATH}`);
      process.exit(1);
    }
  }
  if (OLD_ADAPTER.toLowerCase() === NEW_ADAPTER.toLowerCase()) {
    console.error("EVM_ADAPTER_ADDRESS and EVM_ESCROW_ADAPTER_ADDRESS are identical; nothing to mirror.");
    process.exit(1);
  }
}

function decodeUln(bytes: string) {
  const [c] = ethers.AbiCoder.defaultAbiCoder().decode([ULN_ABI_TUPLE], bytes);
  return {
    confirmations: c[0] as bigint,
    requiredDVNCount: Number(c[1]),
    optionalDVNCount: Number(c[2]),
    optionalDVNThreshold: Number(c[3]),
    requiredDVNs: c[4] as string[],
    optionalDVNs: c[5] as string[],
  };
}

function printUln(label: string, raw: string) {
  console.log(`\n${label}`);
  if (!raw || raw === "0x") {
    console.log("  <empty> (no explicit OApp config; endpoint falls back to library default)");
    return;
  }
  const u = decodeUln(raw);
  console.log(`  confirmations:        ${u.confirmations}`);
  console.log(`  requiredDVNCount:     ${u.requiredDVNCount}`);
  console.log(`  requiredDVNs:         ${u.requiredDVNs.join(", ") || "(none)"}`);
  console.log(`  optionalDVNCount:     ${u.optionalDVNCount}`);
  console.log(`  optionalDVNThreshold: ${u.optionalDVNThreshold}`);
  console.log(`  optionalDVNs:         ${u.optionalDVNs.join(", ") || "(none)"}`);
  console.log(`  raw:                  ${raw}`);
}

async function main() {
  requireEnv();
  const { apply } = parseArgs();

  const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(EVM_RELAYER_KEY, provider);
  const endpoint = new ethers.Contract(LZ_ENDPOINT, endpointAbi, wallet);

  console.log("=== EVM receive-ULN mirror (old adapter -> new escrow adapter) ===");
  console.log(`  Env file:     ${ENV_PATH}`);
  console.log(`  Endpoint:     ${LZ_ENDPOINT}`);
  console.log(`  Old adapter:  ${OLD_ADAPTER}  (source of truth)`);
  console.log(`  New adapter:  ${NEW_ADAPTER}  (target)`);
  console.log(`  Source EID:   ${SUI_EID}  (return proofs originate on Sui)`);
  console.log(`  Signer:       ${wallet.address}  (must be the new adapter's OApp delegate)`);

  // Resolve the receive libraries. They should be the same ULN302 for both.
  const [oldRecvLib] = await endpoint.getReceiveLibrary(OLD_ADAPTER, SUI_EID);
  const [newRecvLib] = await endpoint.getReceiveLibrary(NEW_ADAPTER, SUI_EID);
  const receiveLib = RECEIVE_LIB_OVERRIDE || newRecvLib;
  console.log(`\n  Old receive lib: ${oldRecvLib}`);
  console.log(`  New receive lib: ${newRecvLib}`);
  if (RECEIVE_LIB_OVERRIDE) console.log(`  Using override:  ${receiveLib}`);
  if (oldRecvLib.toLowerCase() !== newRecvLib.toLowerCase()) {
    console.log("  [WARN] receive libs differ between adapters; mirroring onto the NEW adapter's lib.");
  }

  // Read the OLD adapter's explicit receive-ULN config (the source of truth).
  const oldRaw: string = await endpoint.getConfig(OLD_ADAPTER, oldRecvLib, SUI_EID, CONFIG_TYPE_ULN);
  printUln("OLD adapter receive-ULN config (to mirror):", oldRaw);

  if (!oldRaw || oldRaw === "0x") {
    console.error(
      "\n[FAIL] Old adapter has NO explicit receive-ULN config. Cannot mirror an empty" +
        "\n       config (that would leave the new adapter on the dead LZ-default DVN)." +
        "\n       Re-run against an adapter whose 0x9665 DVN is set, or extend this helper" +
        "\n       to encode an explicit required-DVN set.",
    );
    process.exit(1);
  }

  const old = decodeUln(oldRaw);
  if (old.requiredDVNCount === 0 || old.requiredDVNs.length === 0) {
    console.error("\n[FAIL] Old adapter's receive-ULN has no required DVN; refusing to mirror an unverifiable config.");
    process.exit(1);
  }
  console.log(`\n  -> ${old.requiredDVNs.length} required DVN(s) will be mirrored: ${old.requiredDVNs.join(", ")}`);

  // Show the NEW adapter's current config for a before/after comparison.
  const newRawBefore: string = await endpoint.getConfig(NEW_ADAPTER, receiveLib, SUI_EID, CONFIG_TYPE_ULN);
  printUln("NEW adapter receive-ULN config (BEFORE):", newRawBefore);

  if (newRawBefore.toLowerCase() === oldRaw.toLowerCase()) {
    console.log("\n[OK] New adapter already mirrors the old receive-ULN config. Nothing to do.");
    return;
  }

  // The exact setConfig call that would be broadcast (byte-for-byte mirror).
  const params = [{ eid: SUI_EID, configType: CONFIG_TYPE_ULN, config: oldRaw }];
  console.log("\n=== setConfig call ===");
  console.log(`  endpoint.setConfig(`);
  console.log(`    _oapp:   ${NEW_ADAPTER}`);
  console.log(`    _lib:    ${receiveLib}`);
  console.log(`    _params: [{ eid: ${SUI_EID}, configType: ${CONFIG_TYPE_ULN}, config: ${oldRaw} }]`);
  console.log(`  )  from ${wallet.address}`);

  if (!apply) {
    console.log("\n[DRY RUN] Nothing broadcast. Re-run with --apply to send the setConfig tx.");
    // Static-call to surface a revert (e.g. wrong delegate) before any live run.
    try {
      await endpoint.setConfig.staticCall(NEW_ADAPTER, receiveLib, params);
      console.log("[OK] staticCall(setConfig) succeeded: the signer is authorized and the call would not revert.");
    } catch (err: any) {
      console.log(`[WARN] staticCall(setConfig) reverted: ${err.shortMessage || err.message}`);
      console.log("       Likely the signer is not the new adapter's OApp delegate. Fix before --apply.");
    }
    return;
  }

  console.log("\n=== BROADCASTING setConfig ===");
  const tx = await endpoint.setConfig(NEW_ADAPTER, receiveLib, params);
  console.log(`  tx sent: ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  [OK] mined in block ${receipt?.blockNumber}`);

  // Verify the write landed and matches the old config exactly.
  const newRawAfter: string = await endpoint.getConfig(NEW_ADAPTER, receiveLib, SUI_EID, CONFIG_TYPE_ULN);
  printUln("NEW adapter receive-ULN config (AFTER):", newRawAfter);
  if (newRawAfter.toLowerCase() === oldRaw.toLowerCase()) {
    console.log("\n[OK] New adapter receive-ULN now mirrors the old adapter exactly.");
  } else {
    console.error("\n[FAIL] Post-write config does NOT match the old adapter. Inspect before proceeding.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
