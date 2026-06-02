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

const ULN302 = process.env.SUI_LZ_ULN302!;
const ULN302_OBJ = process.env.SUI_LZ_ULN302_OBJ!;
const EVM_EID = 30101;

const WBTC_PKG = "0xf028303ea0d8dc2ac3ec17c696ca04f097d0c9af01e8a6607dc28242bd393a8c";
const OUR_PKG = process.env.SUI_LZ_PACKAGE_ID!;

async function getExecutorConfig(label: string, oappPkg: string) {
  // Get effective executor config (OApp-specific if set, else default)
  const tx = new Transaction();
  tx.moveCall({
    target: `${ULN302}::uln_302::get_effective_executor_config`,
    arguments: [
      tx.object(ULN302_OBJ),
      tx.pure.address(oappPkg),
      tx.pure.u32(EVM_EID),
    ],
  });
  const result = await suiClient.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: keypair.toSuiAddress(),
  });
  if (result.effects?.status?.status !== "success") {
    console.log(`${label}: FAIL`, result.effects?.status?.error?.slice(0, 200));
    return;
  }
  const bytes: number[] = result.results?.[0]?.returnValues?.[0]?.[0] as number[];
  if (!bytes) { console.log(`${label}: no return data`); return; }
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  console.log(`${label} executor config (${bytes.length} bytes): ${hex}`);

  // Parse BCS: u64 max_message_size (8 bytes LE) + address (32 bytes)
  if (bytes.length >= 40) {
    const maxMsgSize = bytes.slice(0, 8).reduce((acc, b, i) => acc + BigInt(b) * (2n ** BigInt(i * 8)), 0n);
    const executor = "0x" + Array.from(bytes.slice(8, 40)).map(b => b.toString(16).padStart(2, "0")).join("");
    console.log(`  max_message_size: ${maxMsgSize}`);
    console.log(`  executor: ${executor}`);
  }
}

async function main() {
  console.log("=== Executor Config Comparison ===\n");
  await getExecutorConfig("wBTC", WBTC_PKG);
  console.log();
  await getExecutorConfig("Bosphor", OUR_PKG);
}

main().catch(console.error);
