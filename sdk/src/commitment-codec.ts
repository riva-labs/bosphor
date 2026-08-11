/**
 * CommitmentCodec: the single source of truth for the Bosphor intent commitment
 * wire format and intentId derivation. Implemented identically in Solidity, Move,
 * and TypeScript (and, later, Rust/Anchor) and pinned by shared parity vectors.
 *
 * Canonical commitment layout (49 bytes, big-endian):
 *   blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
 *
 * Storage is committed as a duration (`storageEpochs`), never an absolute end
 * epoch, because origin chains do not know the current Walrus epoch.
 *
 * intentId derivation:
 *   keccak256( commitment(49) ++ sender(32, left-padded big-endian) ++ nonce(u64) )
 */

import { keccak_256 } from "@noble/hashes/sha3.js";

export const COMMITMENT_BYTES = 49;
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

/** Encodes a commitment to its canonical 49-byte big-endian representation. */
export function encodeCommitment(c: Commitment): Uint8Array {
  if (c.blobId.length !== BLOB_ID_BYTES) {
    throw new Error(`blobId must be ${BLOB_ID_BYTES} bytes, got ${c.blobId.length}`);
  }

  const out = new Uint8Array(COMMITMENT_BYTES);
  out.set(c.blobId, 0);

  const view = new DataView(out.buffer);
  writeUintBE(view, 32, BigInt(c.size), 4); // size u32
  view.setUint8(36, c.encodingType); //         encodingType u8
  writeUintBE(view, 37, BigInt(c.storageEpochs), 4); // storageEpochs u32
  writeUintBE(view, 41, c.deadline, 8); //      deadline u64

  return out;
}

function readUintBE(view: DataView, offset: number, byteLength: number): bigint {
  let value = 0n;
  for (let i = 0; i < byteLength; i++) {
    value = (value << 8n) | BigInt(view.getUint8(offset + i));
  }
  return value;
}

/** Decodes a canonical 49-byte commitment. Inverse of {@link encodeCommitment}. */
export function decodeCommitment(bytes: Uint8Array): Commitment {
  if (bytes.length !== COMMITMENT_BYTES) {
    throw new Error(`commitment must be ${COMMITMENT_BYTES} bytes, got ${bytes.length}`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    blobId: bytes.slice(0, BLOB_ID_BYTES),
    size: Number(readUintBE(view, 32, 4)),
    encodingType: view.getUint8(36),
    storageEpochs: Number(readUintBE(view, 37, 4)),
    deadline: readUintBE(view, 41, 8),
  };
}

/**
 * Derives the canonical, chain-agnostic intentId:
 *   keccak256( commitment(49) ++ sender(32, left-padded big-endian) ++ nonce(u64) )
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
