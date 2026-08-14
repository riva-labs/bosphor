/**
 * Solana proof reader: the `BosphorProof` analog for the Solana adapter.
 *
 * On EVM the execution proof is the `IntentExecuted` event's `abi.encode(blobId,
 * endEpoch)`. On Solana the proof of record is the on-chain `IntentState` PDA
 * (`[b"intent", intentId]`), which `lz_receive` mutates to `executed = true` and
 * writes `end_epoch` + the returned blob id. So verifying a Solana intent means
 * reading that PDA; this module deserializes it.
 *
 * `awaitProof` in the client consumes the already-deserialized `SolanaIntentState`
 * from the backend's `readIntent`. This module additionally exposes the raw Anchor
 * account layout so a consumer holding raw PDA bytes (e.g. from
 * `connection.getAccountInfo`) can decode them without pulling in Anchor. It never
 * fabricates values: a missing or malformed account throws.
 *
 * Anchor `IntentState` layout (from
 * `solana/programs/bosphor-adapter/src/state.rs`), little-endian scalars, after the
 * 8-byte account discriminator:
 *
 *   offset  size  field
 *   0       8     Anchor discriminator
 *   8       32    committed_blob_id : [u8; 32]
 *   40      4     size              : u32  (LE)
 *   44      4     storage_epochs    : u32  (LE)
 *   48      8     deadline          : u64  (LE)
 *   56      32    sender            : Pubkey
 *   88      8     nonce             : u64  (LE)
 *   96      1     executed          : bool
 *   97      8     end_epoch         : u64  (LE)
 *   105     1     bump              : u8
 *
 * Total account data length: 106 bytes.
 */

import type { Hex } from "../types.ts";
import type { SolanaIntentState } from "./client.ts";

/** Byte length of the `IntentState` account data, including the 8-byte discriminator. */
export const INTENT_STATE_LEN = 106;

const OFF_DISCRIMINATOR = 0;
const OFF_COMMITTED_BLOB_ID = 8;
const OFF_SIZE = 40;
const OFF_STORAGE_EPOCHS = 44;
const OFF_DEADLINE = 48;
const OFF_SENDER = 56;
const OFF_NONCE = 88;
const OFF_EXECUTED = 96;
const OFF_END_EPOCH = 97;
const OFF_BUMP = 105;

/** Fully decoded `IntentState` account, mirroring the on-chain struct fields. */
export interface DecodedIntentState {
  /** The blob id committed at submission, as 0x hex. */
  committedBlobId: Hex;
  /** Committed blob size in bytes (u32). */
  size: number;
  /** Committed Walrus storage duration in epochs (u32). */
  storageEpochs: number;
  /** Intent deadline as unix seconds (u64). */
  deadline: bigint;
  /** The 32-byte Solana account that submitted the intent, as 0x hex. */
  sender: Hex;
  /** Per-sender nonce used in the intent id derivation (u64). */
  nonce: bigint;
  /** Whether the return proof has been recorded. */
  executed: boolean;
  /** Walrus end epoch recorded on execution (0n until executed). */
  endEpoch: bigint;
  /** PDA bump. */
  bump: number;
}

function toHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

function readU32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function readU64LE(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}

/**
 * Decode the raw `IntentState` PDA account data into its fields. Reads directly
 * from the Anchor byte layout so a caller holding raw account bytes never needs
 * Anchor. Throws loudly on a malformed (wrong-length) account rather than
 * fabricating values.
 */
export function decodeIntentState(data: Uint8Array): DecodedIntentState {
  if (data.length !== INTENT_STATE_LEN) {
    throw new Error(
      `IntentState account must be ${INTENT_STATE_LEN} bytes, got ${data.length}`,
    );
  }
  void OFF_DISCRIMINATOR;

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  return {
    committedBlobId: toHex(data.subarray(OFF_COMMITTED_BLOB_ID, OFF_COMMITTED_BLOB_ID + 32)),
    size: readU32LE(view, OFF_SIZE),
    storageEpochs: readU32LE(view, OFF_STORAGE_EPOCHS),
    deadline: readU64LE(view, OFF_DEADLINE),
    sender: toHex(data.subarray(OFF_SENDER, OFF_SENDER + 32)),
    nonce: readU64LE(view, OFF_NONCE),
    executed: view.getUint8(OFF_EXECUTED) !== 0,
    endEpoch: readU64LE(view, OFF_END_EPOCH),
    bump: view.getUint8(OFF_BUMP),
  };
}

/**
 * The `BosphorProof.read`-style helper: reduce an `IntentState` (raw account bytes
 * or an already-decoded `SolanaIntentState`) to the verified proof triple the
 * caller cares about, `{ executed, blobId, endEpoch }`. Never fabricates values;
 * an un-executed intent reports `executed: false`, and the caller decides whether
 * to trust `blobId`/`endEpoch` (which are 0 until execution).
 */
export function readSolanaProof(
  state: Uint8Array | SolanaIntentState | DecodedIntentState,
): { executed: boolean; blobId: Hex; endEpoch: bigint } {
  if (state instanceof Uint8Array) {
    const decoded = decodeIntentState(state);
    return {
      executed: decoded.executed,
      blobId: decoded.committedBlobId,
      endEpoch: decoded.endEpoch,
    };
  }
  return { executed: state.executed, blobId: state.committedBlobId, endEpoch: state.endEpoch };
}
