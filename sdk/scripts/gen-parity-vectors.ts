/**
 * Generates the cross-chain parity vectors from the TypeScript reference codec.
 *
 * Outputs (single source of truth -> per-language fixtures, zero drift):
 *   - shared/parity/commitment-vectors.json   (canonical; read by TS + Forge)
 *   - contracts/sui/lz-receiver/tests/commitment_vectors.move  (generated; Move can't read files)
 *   - contracts/solana/commitment-codec/tests/parity_vectors.rs  (generated)
 *
 * Besides the positive version-1 vectors, this emits negative fixtures: full
 * 50-byte commitments whose version byte is 0 or 2. Every implementation must
 * reject them (Solidity revert, Move abort, SDK typed error, Rust error).
 *
 * Re-run with `npm run gen:vectors` in sdk/. CI asserts the working tree is clean
 * afterwards, so the fixtures can never silently drift from the reference codec.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { COMMITMENT_VERSION, encodeCommitment, deriveIntentId } from "../src/commitment-codec.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Input {
  name: string;
  blobId: string; // 32-byte hex
  size: number; // u32
  encodingType: number; // u8
  storageEpochs: number; // u32
  deadline: bigint; // u64
  sender: string; // hex, <= 32 bytes
  nonce: bigint; // u64
}

const U32_MAX = 0xffffffff;
const U64_MAX = (1n << 64n) - 1n;

const inputs: Input[] = [
  {
    name: "all_zero",
    blobId: "00".repeat(32),
    size: 0,
    encodingType: 0,
    storageEpochs: 0,
    deadline: 0n,
    sender: "00".repeat(32),
    nonce: 0n,
  },
  {
    name: "default_epochs_evm_zero_sender",
    blobId: "00".repeat(32),
    size: 0,
    encodingType: 0,
    storageEpochs: 5,
    deadline: 0n,
    sender: "00".repeat(20), // 20-byte EVM zero address, left-padded to 32
    nonce: 0n,
  },
  {
    name: "canonical_evm",
    blobId: "ab".repeat(32),
    size: 1024,
    encodingType: 1,
    storageEpochs: 5,
    deadline: 1_760_000_000n,
    sender: "00112233445566778899aabbccddeeff00112233", // 20-byte EVM address
    nonce: 7n,
  },
  {
    name: "sui_sender",
    blobId: "deadbeef".repeat(8),
    size: 1,
    encodingType: 2,
    storageEpochs: 10,
    deadline: 1_234_567_890n,
    sender: "cafe".repeat(16), // 32-byte Sui/Solana address
    nonce: 1n,
  },
  {
    name: "max_fields",
    blobId: "ff".repeat(32),
    size: U32_MAX,
    encodingType: 0xff,
    storageEpochs: U32_MAX,
    deadline: U64_MAX,
    sender: "ff".repeat(32),
    nonce: U64_MAX,
  },
];

interface Vector extends Input {
  commitment: string;
  intentId: string;
}

const vectors: Vector[] = inputs.map((i) => {
  const c = {
    blobId: hexToBytes(i.blobId),
    size: i.size,
    encodingType: i.encodingType,
    storageEpochs: i.storageEpochs,
    deadline: i.deadline,
  };
  return {
    ...i,
    commitment: bytesToHex(encodeCommitment(c)),
    intentId: bytesToHex(deriveIntentId(c, hexToBytes(i.sender), i.nonce)),
  };
});

// Negative fixtures: the canonical_evm commitment with the version byte swapped
// for versions no implementation understands. Decoders must reject these.
interface InvalidVector {
  name: string;
  version: number;
  commitment: string;
}

const canonical = vectors.find((v) => v.name === "canonical_evm")!;
const invalidVectors: InvalidVector[] = [0, 2].map((version) => {
  const bytes = hexToBytes(canonical.commitment);
  bytes[0] = version;
  return {
    name: `unsupported_version_${version}`,
    version,
    commitment: bytesToHex(bytes),
  };
});

// --- canonical JSON (bigints as decimal strings) ---
const json = {
  format:
    "version(u8=1) ++ blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64), big-endian",
  version: COMMITMENT_VERSION,
  intentId: "keccak256(commitment(50) ++ sender(32,left-padded BE) ++ nonce(u64 BE))",
  vectors: vectors.map((v) => ({
    name: v.name,
    blobId: v.blobId,
    size: v.size,
    encodingType: v.encodingType,
    storageEpochs: v.storageEpochs,
    deadline: v.deadline.toString(),
    sender: v.sender,
    nonce: v.nonce.toString(),
    commitment: v.commitment,
    intentId: v.intentId,
  })),
  invalidVectors: invalidVectors.map((v) => ({
    name: v.name,
    version: v.version,
    commitment: v.commitment,
  })),
};

const jsonPath = resolve(repoRoot, "shared/parity/commitment-vectors.json");
mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(jsonPath, JSON.stringify(json, null, 2) + "\n");

// --- generated Move fixture ---
const entry = (v: Vector) =>
  `    v.push_back(Vector {\n` +
  `        name: b"${v.name}",\n` +
  `        blob_id: x"${v.blobId}",\n` +
  `        size: ${v.size},\n` +
  `        encoding_type: ${v.encodingType},\n` +
  `        storage_epochs: ${v.storageEpochs},\n` +
  `        deadline: ${v.deadline.toString()},\n` +
  `        sender: x"${v.sender}",\n` +
  `        nonce: ${v.nonce.toString()},\n` +
  `        commitment: x"${v.commitment}",\n` +
  `        intent_id: x"${v.intentId}",\n` +
  `    });`;

const invalidEntry = (v: InvalidVector) =>
  `    v.push_back(InvalidVector {\n` +
  `        name: b"${v.name}",\n` +
  `        version: ${v.version},\n` +
  `        commitment: x"${v.commitment}",\n` +
  `    });`;

const moveSrc =
  `// @generated by sdk/scripts/gen-parity-vectors.ts -- DO NOT EDIT.\n` +
  `// Cross-chain parity vectors for bosphor_lz::commitment_codec.\n` +
  `#[test_only]\n` +
  `module bosphor_lz::commitment_vectors;\n\n` +
  `public struct Vector has copy, drop {\n` +
  `    name: vector<u8>,\n` +
  `    blob_id: vector<u8>,\n` +
  `    size: u32,\n` +
  `    encoding_type: u8,\n` +
  `    storage_epochs: u32,\n` +
  `    deadline: u64,\n` +
  `    sender: vector<u8>,\n` +
  `    nonce: u64,\n` +
  `    commitment: vector<u8>,\n` +
  `    intent_id: vector<u8>,\n` +
  `}\n\n` +
  `public fun blob_id(v: &Vector): vector<u8> { v.blob_id }\n` +
  `public fun size(v: &Vector): u32 { v.size }\n` +
  `public fun encoding_type(v: &Vector): u8 { v.encoding_type }\n` +
  `public fun storage_epochs(v: &Vector): u32 { v.storage_epochs }\n` +
  `public fun deadline(v: &Vector): u64 { v.deadline }\n` +
  `public fun sender(v: &Vector): vector<u8> { v.sender }\n` +
  `public fun nonce(v: &Vector): u64 { v.nonce }\n` +
  `public fun commitment(v: &Vector): vector<u8> { v.commitment }\n` +
  `public fun intent_id(v: &Vector): vector<u8> { v.intent_id }\n\n` +
  `/// A full-length commitment whose version byte is not a supported version.\n` +
  `/// Every decoder must reject it.\n` +
  `public struct InvalidVector has copy, drop {\n` +
  `    name: vector<u8>,\n` +
  `    version: u8,\n` +
  `    commitment: vector<u8>,\n` +
  `}\n\n` +
  `public fun invalid_name(v: &InvalidVector): vector<u8> { v.name }\n` +
  `public fun invalid_version(v: &InvalidVector): u8 { v.version }\n` +
  `public fun invalid_commitment(v: &InvalidVector): vector<u8> { v.commitment }\n\n` +
  `public fun all(): vector<Vector> {\n` +
  `    let mut v = vector::empty<Vector>();\n` +
  vectors.map(entry).join("\n") +
  `\n    v\n}\n\n` +
  `public fun invalid_all(): vector<InvalidVector> {\n` +
  `    let mut v = vector::empty<InvalidVector>();\n` +
  invalidVectors.map(invalidEntry).join("\n") +
  `\n    v\n}\n`;


const movePath = resolve(repoRoot, "contracts/sui/lz-receiver/tests/commitment_vectors.move");
writeFileSync(movePath, moveSrc);

// --- generated Rust fixture (integration test for the Solana-side codec) ---
const rustEntry = (v: Vector) =>
  `    V {\n` +
  `        blob_id: "${v.blobId}",\n` +
  `        size: ${v.size},\n` +
  `        encoding_type: ${v.encodingType},\n` +
  `        storage_epochs: ${v.storageEpochs},\n` +
  `        deadline: ${v.deadline.toString()},\n` +
  `        sender: "${v.sender}",\n` +
  `        nonce: ${v.nonce.toString()},\n` +
  `        commitment: "${v.commitment}",\n` +
  `        intent_id: "${v.intentId}",\n` +
  `    },`;

const rustInvalidEntry = (v: InvalidVector) => `    ("${v.name}", ${v.version}, "${v.commitment}"),`;

const rustSrc =
  `// @generated by sdk/scripts/gen-parity-vectors.ts -- DO NOT EDIT.\n` +
  `// Cross-chain parity vectors for bosphor_commitment_codec.\n` +
  `use bosphor_commitment_codec::{decode, derive_intent_id, encode, Commitment, DecodeError};\n\n` +
  `struct V {\n` +
  `    blob_id: &'static str,\n` +
  `    size: u32,\n` +
  `    encoding_type: u8,\n` +
  `    storage_epochs: u32,\n` +
  `    deadline: u64,\n` +
  `    sender: &'static str,\n` +
  `    nonce: u64,\n` +
  `    commitment: &'static str,\n` +
  `    intent_id: &'static str,\n` +
  `}\n\n` +
  `const VECTORS: &[V] = &[\n` +
  vectors.map(rustEntry).join("\n") +
  `\n];\n\n` +
  `// (name, version byte, full-length commitment hex) that decode must reject.\n` +
  `const INVALID_VECTORS: &[(&str, u8, &str)] = &[\n` +
  invalidVectors.map(rustInvalidEntry).join("\n") +
  `\n];\n\n` +
  `fn unhex(s: &str) -> Vec<u8> {\n` +
  `    (0..s.len() / 2)\n` +
  `        .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())\n` +
  `        .collect()\n` +
  `}\n\n` +
  `fn hex(b: &[u8]) -> String {\n` +
  `    b.iter().map(|x| format!("{:02x}", x)).collect()\n` +
  `}\n\n` +
  `#[test]\n` +
  `fn parity_vectors_match() {\n` +
  `    for v in VECTORS {\n` +
  `        let mut blob_id = [0u8; 32];\n` +
  `        blob_id.copy_from_slice(&unhex(v.blob_id));\n` +
  `        let c = Commitment {\n` +
  `            blob_id,\n` +
  `            size: v.size,\n` +
  `            encoding_type: v.encoding_type,\n` +
  `            storage_epochs: v.storage_epochs,\n` +
  `            deadline: v.deadline,\n` +
  `        };\n` +
  `        assert_eq!(hex(&encode(&c)), v.commitment, "commitment mismatch");\n` +
  `        assert_eq!(\n` +
  `            hex(&derive_intent_id(&c, &unhex(v.sender), v.nonce)),\n` +
  `            v.intent_id,\n` +
  `            "intentId mismatch"\n` +
  `        );\n` +
  `    }\n` +
  `}\n\n` +
  `#[test]\n` +
  `fn invalid_versions_are_rejected() {\n` +
  `    for (name, version, commitment) in INVALID_VECTORS {\n` +
  `        assert_eq!(\n` +
  `            decode(&unhex(commitment)),\n` +
  `            Err(DecodeError::UnsupportedVersion(*version)),\n` +
  `            "decode must reject {}",\n` +
  `            name\n` +
  `        );\n` +
  `    }\n` +
  `}\n`;

const rustPath = resolve(repoRoot, "contracts/solana/commitment-codec/tests/parity_vectors.rs");
mkdirSync(dirname(rustPath), { recursive: true });
writeFileSync(rustPath, rustSrc);

console.log(`wrote ${vectors.length} vectors ->`);
console.log(`  ${jsonPath}`);
console.log(`  ${movePath}`);
console.log(`  ${rustPath}`);
