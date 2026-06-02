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

const LZ_ENDPOINT_PKG = process.env.SUI_LZ_ENDPOINT_V2!;
const LZ_ENDPOINT_OBJ = process.env.SUI_LZ_ENDPOINT_V2_OBJ!;

const WBTC_PKG = "0xf028303ea0d8dc2ac3ec17c696ca04f097d0c9af01e8a6607dc28242bd393a8c";
const OUR_PKG = process.env.SUI_LZ_PACKAGE_ID!;

async function getOAppInfo(label: string, pkgId: string) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${LZ_ENDPOINT_PKG}::endpoint_v2::get_oapp_info`,
    arguments: [tx.object(LZ_ENDPOINT_OBJ), tx.pure.address(pkgId)],
  });
  const result = await suiClient.devInspectTransactionBlock({
    transactionBlock: tx,
    sender: keypair.toSuiAddress(),
  });
  if (result.effects?.status?.status !== "success") {
    console.log(`${label}: FAIL - ${result.effects?.status?.error?.slice(0, 100)}`);
    return;
  }
  const bytes: number[] = result.results?.[0]?.returnValues?.[0]?.[0] as number[];
  if (!bytes) { console.log(`${label}: no data`); return; }

  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
  console.log(`${label} (${bytes.length} bytes):`);
  console.log(`  HEX: ${hex}`);

  // Extract ASCII strings (module/function names)
  const ascii = Array.from(bytes).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("");
  console.log(`  ASCII: ${ascii}`);
}

async function main() {
  console.log("=== OApp Info Comparison ===\n");
  await getOAppInfo("wBTC", WBTC_PKG);
  console.log();
  await getOAppInfo("Bosphor", OUR_PKG);
}

main().catch(console.error);
