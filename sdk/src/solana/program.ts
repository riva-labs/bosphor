/**
 * IDL-free binary interface for the Bosphor Solana adapter program.
 *
 * The LayerZero Solana crates cannot generate an Anchor IDL under our toolchain,
 * so instead of depending on a generated client this module owns the program's
 * wire format explicitly: Anchor-style 8-byte discriminators (computed the exact
 * same way Anchor does, `sha256("<kind>:<name>")[..8]`) plus borsh encoders for
 * instructions and decoders for accounts and events. The surface is small and
 * frozen, and `KNOWN_DISCRIMINATORS` pins it to the compiled program so a drift in
 * either side fails a test rather than production.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as toHex, hexToBytes as fromHex } from "@noble/hashes/utils.js";
import type { Hex } from "../types.ts";

// --- discriminators (identical to Anchor) ---

function discriminator(preimage: string): Uint8Array {
  return sha256(new TextEncoder().encode(preimage)).slice(0, 8);
}
export const instructionDiscriminator = (snakeName: string): Uint8Array =>
  discriminator(`global:${snakeName}`);
export const accountDiscriminator = (pascalName: string): Uint8Array =>
  discriminator(`account:${pascalName}`);
export const eventDiscriminator = (pascalName: string): Uint8Array =>
  discriminator(`event:${pascalName}`);

/**
 * Ground-truth discriminators captured from the compiled `bosphor_adapter`
 * program (via Anchor's `Discriminator` trait). The parity test asserts the
 * computed values equal these, so the codec can never silently diverge from the
 * on-chain program.
 */
export const KNOWN_DISCRIMINATORS = {
  instruction: {
    init_store: "fa4a065fa3bc13b5",
    set_peer: "2046b8e5c873e3b1",
    submit_intent: "9fff9909958b4970",
    lz_receive: "08b3786d2176bd50",
    lz_receive_types: "dd11f69ff8801f60",
    confirm_execution: "224bf749597f657b",
  },
  account: {
    IntentState: "5f7b9d724a1ddd73",
    Store: "8230f7f4b6bf1e1a",
    Peer: "3208133728fd253a",
    SenderNonce: "0e33c665da87ece2",
  },
  event: {
    IntentSubmitted: "ce64e78df51e5063",
    IntentExecuted: "b32fee483453bce3",
  },
} as const;

// --- minimal borsh writer / reader ---

class ByteWriter {
  private parts: Uint8Array[] = [];
  bytes(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  u8(v: number): this {
    return this.bytes(Uint8Array.of(v & 0xff));
  }
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true); // little-endian
    return this.bytes(b);
  }
  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true); // little-endian
    return this.bytes(b);
  }
  vecU8(v: Uint8Array): this {
    return this.u32(v.length).bytes(v);
  }
  finish(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.length;
    }
    return out;
  }
}

class ByteReader {
  private o = 0;
  constructor(private readonly data: Uint8Array) {}
  take(n: number): Uint8Array {
    const s = this.data.subarray(this.o, this.o + n);
    if (s.length !== n) throw new Error(`unexpected end of buffer at offset ${this.o}`);
    this.o += n;
    return s;
  }
  u8(): number {
    return this.take(1)[0]!;
  }
  u32(): number {
    return new DataView(this.take(4).slice().buffer).getUint32(0, true);
  }
  u64(): bigint {
    return new DataView(this.take(8).slice().buffer).getBigUint64(0, true);
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
}

// --- instruction data encoders ---

export interface SubmitIntentArgs {
  blobId: Hex;
  size: number;
  encodingType: number;
  storageEpochs: number;
  deadline: bigint;
  dstEid: number;
  options: Uint8Array;
  nativeFee: bigint;
}

/** Encodes the `submit_intent` instruction data (discriminator ++ borsh args). */
export function encodeSubmitIntentData(a: SubmitIntentArgs): Uint8Array {
  const blob = fromHex(a.blobId.startsWith("0x") ? a.blobId.slice(2) : a.blobId);
  if (blob.length !== 32) throw new Error(`blobId must be 32 bytes, got ${blob.length}`);
  return new ByteWriter()
    .bytes(instructionDiscriminator("submit_intent"))
    .bytes(blob)
    .u32(a.size)
    .u8(a.encodingType)
    .u32(a.storageEpochs)
    .u64(a.deadline)
    .u32(a.dstEid)
    .vecU8(a.options)
    .u64(a.nativeFee)
    .finish();
}

/** Encodes `init_store` (params: admin Pubkey, endpointProgram Option<Pubkey>). */
export function encodeInitStoreData(admin: Uint8Array, endpointProgram?: Uint8Array): Uint8Array {
  if (admin.length !== 32) throw new Error("admin must be a 32-byte pubkey");
  const w = new ByteWriter().bytes(instructionDiscriminator("init_store")).bytes(admin);
  if (endpointProgram) {
    if (endpointProgram.length !== 32) throw new Error("endpointProgram must be a 32-byte pubkey");
    w.u8(1).bytes(endpointProgram);
  } else {
    w.u8(0);
  }
  return w.finish();
}

/** Encodes `set_peer` (params: eid u32, peer [u8;32]). */
export function encodeSetPeerData(eid: number, peer: Uint8Array): Uint8Array {
  if (peer.length !== 32) throw new Error("peer must be 32 bytes");
  return new ByteWriter().bytes(instructionDiscriminator("set_peer")).u32(eid).bytes(peer).finish();
}

/**
 * Encodes `confirm_execution` (args: intentId [u8;32], returnedBlobId [u8;32],
 * endEpoch u64). The owner-gated return-proof fallback; mirrors the EVM adapter's
 * `confirmExecution`.
 */
export function encodeConfirmExecutionData(
  intentId: Hex,
  returnedBlobId: Hex,
  endEpoch: bigint,
): Uint8Array {
  const id = fromHex(intentId.startsWith("0x") ? intentId.slice(2) : intentId);
  const blob = fromHex(returnedBlobId.startsWith("0x") ? returnedBlobId.slice(2) : returnedBlobId);
  if (id.length !== 32) throw new Error(`intentId must be 32 bytes, got ${id.length}`);
  if (blob.length !== 32) throw new Error(`returnedBlobId must be 32 bytes, got ${blob.length}`);
  return new ByteWriter()
    .bytes(instructionDiscriminator("confirm_execution"))
    .bytes(id)
    .bytes(blob)
    .u64(endEpoch)
    .finish();
}

// --- account decoder ---

export interface IntentStateAccount {
  committedBlobId: Hex;
  size: number;
  storageEpochs: number;
  deadline: bigint;
  sender: Uint8Array;
  nonce: bigint;
  executed: boolean;
  endEpoch: bigint;
  bump: number;
}

/** Decodes an `IntentState` account, verifying its discriminator. */
export function decodeIntentState(data: Uint8Array): IntentStateAccount {
  const expected = accountDiscriminator("IntentState");
  for (let i = 0; i < 8; i++) {
    if (data[i] !== expected[i]) {
      throw new Error("account is not an IntentState (discriminator mismatch)");
    }
  }
  const r = new ByteReader(data.subarray(8));
  return {
    committedBlobId: ("0x" + toHex(r.take(32))) as Hex,
    size: r.u32(),
    storageEpochs: r.u32(),
    deadline: r.u64(),
    sender: r.take(32),
    nonce: r.u64(),
    executed: r.bool(),
    endEpoch: r.u64(),
    bump: r.u8(),
  };
}

// --- event decoder ---

/**
 * Extracts the `intent_id` from a raw `IntentSubmitted` event payload
 * (8-byte event discriminator ++ borsh fields; `intent_id` is the first field).
 * Returns null if the payload is not an `IntentSubmitted` event.
 */
export function decodeIntentSubmittedIntentId(eventData: Uint8Array): Hex | null {
  if (eventData.length < 8 + 32) return null;
  const expected = eventDiscriminator("IntentSubmitted");
  for (let i = 0; i < 8; i++) if (eventData[i] !== expected[i]) return null;
  return ("0x" + toHex(eventData.subarray(8, 40))) as Hex;
}

const PROGRAM_DATA_PREFIX = "Program data: ";

/**
 * Scans Anchor program logs for the `IntentSubmitted` event and returns its
 * `intent_id`. Anchor emits events as `Program data: <base64>` lines.
 */
export function findIntentSubmittedIntentId(logs: readonly string[]): Hex | null {
  for (const line of logs) {
    const idx = line.indexOf(PROGRAM_DATA_PREFIX);
    if (idx === -1) continue;
    const b64 = line.slice(idx + PROGRAM_DATA_PREFIX.length).trim();
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    } catch {
      continue;
    }
    const id = decodeIntentSubmittedIntentId(bytes);
    if (id) return id;
  }
  return null;
}
