/**
 * Decoder for the Bosphor Solana adapter's `IntentSubmitted` event.
 *
 * The Solana leg (M3 #242) makes the adapter a LayerZero v2 OApp. When a user
 * calls `submit_intent`, the program emits an Anchor `IntentSubmitted` event that
 * carries every commitment field the relayer needs to bind out-of-band bytes and
 * to run `execute_store`, exactly like the EVM `IntentSubmitted` log does. There
 * is no EVM transaction for a Solana-origin intent, so the relayer reads this
 * event directly to record the commitment early.
 *
 * The event is Anchor-encoded: an 8-byte discriminator followed by borsh
 * (little-endian) fields. The commitment fields are re-exposed here as canonical
 * big-endian hex so they line up with the on-chain commitment the same way the
 * EVM path's bytes32 blob id does. This decoder is pure (no network) and mirrors
 * the proven reconstruction used by the self-operated DVN.
 */

import { getBytes, hexlify } from 'ethers';

/**
 * Anchor discriminator for the `confirm_execution` instruction
 * (sha256("global:confirm_execution")[..8]). Pinned to the compiled program; the
 * SDK's KNOWN_DISCRIMINATORS parity test guards the same value against drift.
 */
export const CONFIRM_EXECUTION_DISC = '224bf749597f657b';

/**
 * Encode the `confirm_execution` instruction data: discriminator ++ intentId(32)
 * ++ returnedBlobId(32) ++ endEpoch(u64 LE). Mirrors the adapter's argument order
 * and the SDK's encoder. `intentId` and `returnedBlobId` are 0x-hex bytes32.
 */
export function encodeConfirmExecutionData(
  intentId: string,
  returnedBlobId: string,
  endEpoch: bigint,
): Buffer {
  const id = getBytes(intentId);
  const blob = getBytes(returnedBlobId);
  if (id.length !== 32) throw new Error(`intentId must be 32 bytes, got ${id.length}`);
  if (blob.length !== 32) throw new Error(`returnedBlobId must be 32 bytes, got ${blob.length}`);
  const epoch = Buffer.alloc(8);
  epoch.writeBigUInt64LE(endEpoch);
  return Buffer.concat([Buffer.from(CONFIRM_EXECUTION_DISC, 'hex'), id, blob, epoch]);
}

/** Anchor discriminator for `IntentSubmitted` (sha256("event:IntentSubmitted")[..8]). */
export const INTENT_SUBMITTED_DISC = 'ce64e78df51e5063';
const PROGRAM_DATA_PREFIX = 'Program data: ';

/** Byte length of the borsh body after the 8-byte discriminator. */
const BODY_LEN = 165;

/**
 * A decoded `IntentSubmitted` event, with commitment fields in the same shape the
 * lifecycle store expects (`committedBlobId` as 0x-hex big-endian, `deadline` in
 * epoch seconds as a bigint). `sender` is the 32-byte Solana submitter pubkey.
 */
export interface SolanaIntentSubmitted {
  /** keccak-derived intent id (0x-hex bytes32), uniform across chains. */
  intentId: string;
  /** Solana submitter pubkey (32 raw bytes). Not a Sui address. */
  sender: Uint8Array;
  /** Committed Walrus blob id as canonical 0x-hex bytes32. */
  committedBlobId: string;
  /** Committed blob size in bytes. */
  size: number;
  encodingType: number;
  storageEpochs: number;
  /** Intent deadline in epoch seconds. */
  deadline: bigint;
  /** LayerZero destination EID this intent was sent to. */
  dstEid: number;
}

/**
 * Decode an `IntentSubmitted` event payload (8-byte disc ++ borsh fields, LE).
 * Returns null if the payload is not an `IntentSubmitted` event or is truncated.
 */
export function decodeIntentSubmitted(data: Uint8Array): SolanaIntentSubmitted | null {
  if (data.length < 8 + BODY_LEN) return null;
  if (Buffer.from(data.subarray(0, 8)).toString('hex') !== INTENT_SUBMITTED_DISC) return null;

  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const take = (n: number): Uint8Array => {
    const s = data.subarray(o, o + n);
    o += n;
    return s;
  };

  const intentId = take(32);
  const sender = take(32);
  o += 8; // nonce (u64 LE), unused for the commitment
  const blobId = take(32);
  const size = v.getUint32(o, true);
  o += 4;
  const encodingType = data[o++]!;
  const storageEpochs = v.getUint32(o, true);
  o += 4;
  const deadline = v.getBigUint64(o, true);
  o += 8;
  const dstEid = v.getUint32(o, true);
  // Remaining fields (guid, lzNonce) are only needed by the DVN, not the relayer.

  return {
    intentId: hexlify(intentId),
    sender,
    committedBlobId: hexlify(blobId),
    size,
    encodingType,
    storageEpochs,
    deadline,
    dstEid,
  };
}

/**
 * Scan Anchor program logs for every `IntentSubmitted` event, in log order.
 * Anchor emits events as `Program data: <base64>` lines.
 */
export function parseIntentSubmittedEvents(logs: readonly string[]): SolanaIntentSubmitted[] {
  const events: SolanaIntentSubmitted[] = [];
  for (const line of logs) {
    const idx = line.indexOf(PROGRAM_DATA_PREFIX);
    if (idx === -1) continue;
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(
        Buffer.from(line.slice(idx + PROGRAM_DATA_PREFIX.length).trim(), 'base64'),
      );
    } catch {
      continue;
    }
    const ev = decodeIntentSubmitted(bytes);
    if (ev) events.push(ev);
  }
  return events;
}
