/**
 * Decode and compare OApp info structures between wBTC and Bosphor.
 * Parses OAppInfoV1 format: [u16 big-endian version][BCS(OAppInfoV1)]
 */
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

// Read a ULEB128-encoded length from a byte array at given offset
function readUleb128(bytes: number[], offset: number): [number, number] {
  let value = 0;
  let shift = 0;
  let pos = offset;
  while (pos < bytes.length) {
    const b = bytes[pos];
    value |= (b & 0x7f) << shift;
    pos++;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return [value, pos];
}

function toHex(bytes: number[]): string {
  return bytes.map(b => b.toString(16).padStart(2, "0")).join("");
}

function toAscii(bytes: number[]): string {
  return bytes.map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : ".").join("");
}

function decodeBcsOAppInfoV1(bcsBytes: number[]) {
  let pos = 0;

  // address: 32 bytes
  const oappObject = "0x" + toHex(bcsBytes.slice(pos, pos + 32));
  pos += 32;

  // next_nonce_info: vector<u8>
  const [nnLen, nnPos] = readUleb128(bcsBytes, pos);
  pos = nnPos;
  const nextNonceInfo = bcsBytes.slice(pos, pos + nnLen);
  pos += nnLen;

  // lz_receive_info: vector<u8>
  const [lrLen, lrPos] = readUleb128(bcsBytes, pos);
  pos = lrPos;
  const lzReceiveInfo = bcsBytes.slice(pos, pos + lrLen);
  pos += lrLen;

  // extra_info: vector<u8>
  const [eiLen, eiPos] = readUleb128(bcsBytes, pos);
  pos = eiPos;
  const extraInfo = bcsBytes.slice(pos, pos + eiLen);
  pos += eiLen;

  return { oappObject, nextNonceInfo, lzReceiveInfo, extraInfo, bytesConsumed: pos };
}

async function getOAppInfo(label: string, pkgId: string): Promise<number[] | null> {
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
    console.log(`${label}: FAIL`);
    return null;
  }
  return result.results?.[0]?.returnValues?.[0]?.[0] as number[];
}

async function main() {
  for (const [label, pkg] of [["wBTC", WBTC_PKG], ["Bosphor", OUR_PKG]]) {
    console.log(`\n=== ${label} OApp Info ===`);
    const rawBytes = await getOAppInfo(label, pkg);
    if (!rawBytes) continue;

    // Raw bytes from devInspect include BCS vector<u8> wrapper: ULEB128 length prefix
    const [vecLen, dataStart] = readUleb128(rawBytes, 0);
    console.log(`  Total vector length: ${vecLen} bytes (starts at offset ${dataStart})`);
    const data = rawBytes.slice(dataStart);

    // First 2 bytes: big-endian u16 version
    const version = (data[0] << 8) | data[1];
    console.log(`  Version: ${version}`);

    // Remaining: BCS-encoded OAppInfoV1
    const bcsData = data.slice(2);
    const info = decodeBcsOAppInfoV1(bcsData);

    console.log(`  oapp_object: ${info.oappObject}`);
    console.log(`  next_nonce_info: ${info.nextNonceInfo.length} bytes${info.nextNonceInfo.length > 0 ? " = " + toHex(info.nextNonceInfo) : " (EMPTY)"}`);
    console.log(`  lz_receive_info: ${info.lzReceiveInfo.length} bytes`);
    console.log(`  extra_info: ${info.extraInfo.length} bytes${info.extraInfo.length > 0 ? " = " + toHex(info.extraInfo) : " (EMPTY)"}`);

    if (info.nextNonceInfo.length > 0) {
      console.log(`  next_nonce_info ASCII: ${toAscii(info.nextNonceInfo)}`);
    }
    console.log(`  lz_receive_info ASCII: ${toAscii(info.lzReceiveInfo)}`);
    if (info.extraInfo.length > 0) {
      console.log(`  extra_info ASCII: ${toAscii(info.extraInfo)}`);
    }
  }
}

main().catch(console.error);
