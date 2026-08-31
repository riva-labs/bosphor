/**
 * CommitmentCodec: the single source of truth for the Bosphor intent commitment
 * wire format and intentId derivation. Implemented identically in Solidity, Move,
 * TypeScript, and Rust (Solana) and pinned by shared parity vectors.
 *
 * Canonical commitment layout (50 bytes, big-endian), format version 1:
 *   version(u8=1) ++ blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
 *
 * The leading version byte lets the format evolve without coordinated redeploys:
 * every decoder rejects versions it does not understand instead of silently
 * misreading the bytes that follow.
 *
 * Storage is committed as a duration (`storageEpochs`), never an absolute end
 * epoch, because origin chains do not know the current Walrus epoch.
 *
 * intentId derivation (covers the versioned bytes):
 *   keccak256( commitment(50) ++ sender(32, left-padded big-endian) ++ nonce(u64) )
 */

import { keccak_256 } from "@noble/hashes/sha3.js";
import { UnsupportedCommitmentVersionError } from "./errors.js";

/** The single commitment wire-format version this SDK build understands. */
export const COMMITMENT_VERSION = 1;
export const COMMITMENT_BYTES = 50;
export const BLOB_ID_BYTES = 32;
/** Canonical sender width in the intentId preimage (big-endian, left-padded). */
export const SENDER_BYTES = 32;

export interface Commitment {
  /** 32-byte Walrus blob id. */
  blobId: Uint8Array;
  /** Blob size in bytes (u32). */
  size: number;
  /** Walrus encoding type (u8). */
  encodingType: number;
  /** Committed storage duration in Walrus epochs (u32). */
  storageEpochs: number;
  /** Intent deadline as unix seconds (u64). */
  deadline: bigint;
}

function writeUintBE(view: DataView, offset: number, value: bigint, byteLength: number): void {
  for (let i = byteLength - 1; i >= 0; i--) {
    view.setUint8(offset + i, Number(value & 0xffn));
    value >>= 8n;
  }
}

/** Encodes a commitment to its canonical 50-byte big-endian version-1 representation. */
export function encodeCommitment(c: Commitment): Uint8Array {
  if (c.blobId.length !== BLOB_ID_BYTES) {
    throw new Error(`blobId must be ${BLOB_ID_BYTES} bytes, got ${c.blobId.length}`);
  }

  const out = new Uint8Array(COMMITMENT_BYTES);
  out[0] = COMMITMENT_VERSION;
  out.set(c.blobId, 1);

  const view = new DataView(out.buffer);
  writeUintBE(view, 33, BigInt(c.size), 4); // size u32
  view.setUint8(37, c.encodingType); //         encodingType u8
  writeUintBE(view, 38, BigInt(c.storageEpochs), 4); // storageEpochs u32
  writeUintBE(view, 42, c.deadline, 8); //      deadline u64

  return out;
}

function readUintBE(view: DataView, offset: number, byteLength: number): bigint {
  let value = 0n;
  for (let i = 0; i < byteLength; i++) {
    value = (value << 8n) | BigInt(view.getUint8(offset + i));
  }
  return value;
}

/**
 * Decodes a canonical 50-byte version-1 commitment. Inverse of {@link encodeCommitment}.
 *
 * @throws Error if `bytes` is not exactly 50 bytes.
 * @throws UnsupportedCommitmentVersionError if the version byte is not 1.
 */
export function decodeCommitment(bytes: Uint8Array): Commitment {
  if (bytes.length !== COMMITMENT_BYTES) {
    throw new Error(`commitment must be ${COMMITMENT_BYTES} bytes, got ${bytes.length}`);
  }
  if (bytes[0] !== COMMITMENT_VERSION) {
    throw new UnsupportedCommitmentVersionError(bytes[0]!, COMMITMENT_VERSION);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    blobId: bytes.slice(1, 1 + BLOB_ID_BYTES),
    size: Number(readUintBE(view, 33, 4)),
    encodingType: view.getUint8(37),
    storageEpochs: Number(readUintBE(view, 38, 4)),
    deadline: readUintBE(view, 42, 8),
  };
}

/**
 * Derives the canonical, chain-agnostic intentId:
 *   keccak256( commitment(50) ++ sender(32, left-padded big-endian) ++ nonce(u64) )
 *
 * The hash covers the versioned commitment bytes, so the same fields under a
 * different format version derive a different intentId.
 *
 * `sender` may be shorter than 32 bytes (e.g. a 20-byte EVM address); it is
 * left-padded with zeros so EVM, Sui, and Solana senders derive uniformly.
 */
export function deriveIntentId(c: Commitment, sender: Uint8Array, nonce: bigint): Uint8Array {
  if (sender.length > SENDER_BYTES) {
    throw new Error(`sender must be <= ${SENDER_BYTES} bytes, got ${sender.length}`);
  }

  const preimage = new Uint8Array(COMMITMENT_BYTES + SENDER_BYTES + 8);
  preimage.set(encodeCommitment(c), 0);
  preimage.set(sender, COMMITMENT_BYTES + (SENDER_BYTES - sender.length));
  writeUintBE(
    new DataView(preimage.buffer),
    COMMITMENT_BYTES + SENDER_BYTES,
    nonce,
    8,
  );

  return keccak_256(preimage);
}
