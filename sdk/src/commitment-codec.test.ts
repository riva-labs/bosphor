import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { encodeCommitment, decodeCommitment, deriveIntentId } from "./commitment-codec.js";

// Tracer: the canonical wire format is
//   blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
// all big-endian, total 49 bytes. This asserts the exact byte layout for a
// hand-verifiable input (all-zero blob, storageEpochs = 5, everything else 0).
test("encodeCommitment produces the canonical 49-byte big-endian layout", () => {
  const bytes = encodeCommitment({
    blobId: hexToBytes("00".repeat(32)),
    size: 0,
    encodingType: 0,
    storageEpochs: 5,
    deadline: 0n,
  });

  const expected =
    "00".repeat(32) + // blobId
    "00000000" + //       size = 0
    "00" + //             encodingType = 0
    "00000005" + //       storageEpochs = 5
    "0000000000000000"; // deadline = 0

  assert.equal(bytes.length, 49);
  assert.equal(bytesToHex(bytes), expected);
});

test("decodeCommitment is the exact inverse of encodeCommitment", () => {
  const commitment = {
    blobId: hexToBytes("11".repeat(32)),
    size: 0x01020304,
    encodingType: 0xab,
    storageEpochs: 5,
    deadline: 1_760_000_000n,
  };

  const decoded = decodeCommitment(encodeCommitment(commitment));

  assert.equal(bytesToHex(decoded.blobId), "11".repeat(32));
  assert.equal(decoded.size, commitment.size);
  assert.equal(decoded.encodingType, commitment.encodingType);
  assert.equal(decoded.storageEpochs, commitment.storageEpochs);
  assert.equal(decoded.deadline, commitment.deadline);
});

test("deriveIntentId hashes commitment ++ sender(32,left-padded) ++ nonce(u64)", () => {
  const commitment = {
    blobId: hexToBytes("22".repeat(32)),
    size: 1024,
    encodingType: 1,
    storageEpochs: 5,
    deadline: 1_760_000_000n,
  };
  // 20-byte EVM address; must be left-padded to 32 bytes in the preimage.
  const sender = hexToBytes("00112233445566778899aabbccddeeff00112233");
  const nonce = 7n;

  const preimage = new Uint8Array(49 + 32 + 8);
  preimage.set(encodeCommitment(commitment), 0);
  preimage.set(sender, 49 + (32 - sender.length)); // left-padded sender
  new DataView(preimage.buffer).setBigUint64(49 + 32, nonce); // nonce u64 BE
  const expected = keccak_256(preimage);

  assert.deepEqual(deriveIntentId(commitment, sender, nonce), expected);
  assert.equal(deriveIntentId(commitment, sender, nonce).length, 32);
});
