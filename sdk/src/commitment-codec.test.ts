import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  COMMITMENT_VERSION,
  encodeCommitment,
  decodeCommitment,
  deriveIntentId,
} from "./commitment-codec.js";
import { UnsupportedCommitmentVersionError } from "./errors.js";

// Tracer: the canonical wire format is
//   version(u8=1) ++ blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
// all big-endian, total 50 bytes. This asserts the exact byte layout for a
// hand-verifiable input (all-zero blob, storageEpochs = 5, everything else 0).
test("encodeCommitment produces the canonical 50-byte big-endian version-1 layout", () => {
  const bytes = encodeCommitment({
    blobId: hexToBytes("00".repeat(32)),
    size: 0,
    encodingType: 0,
    storageEpochs: 5,
    deadline: 0n,
  });

  const expected =
    "01" + //             version = 1
    "00".repeat(32) + // blobId
    "00000000" + //       size = 0
    "00" + //             encodingType = 0
    "00000005" + //       storageEpochs = 5
    "0000000000000000"; // deadline = 0

  assert.equal(bytes.length, 50);
  assert.equal(bytes[0], COMMITMENT_VERSION);
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

test("decodeCommitment rejects unknown versions with a typed error", () => {
  const encoded = encodeCommitment({
    blobId: hexToBytes("11".repeat(32)),
    size: 1,
    encodingType: 0,
    storageEpochs: 1,
    deadline: 0n,
  });

  for (const badVersion of [0, 2, 0xff]) {
    const tampered = new Uint8Array(encoded);
    tampered[0] = badVersion;
    assert.throws(
      () => decodeCommitment(tampered),
      (err: unknown) => {
        assert.ok(err instanceof UnsupportedCommitmentVersionError);
        assert.equal(err.version, badVersion);
        assert.equal(err.supported, COMMITMENT_VERSION);
        assert.equal(err.code, "UNSUPPORTED_COMMITMENT_VERSION");
        return true;
      },
    );
  }
});

test("decodeCommitment rejects wrong lengths (including the legacy 49 bytes)", () => {
  assert.throws(() => decodeCommitment(new Uint8Array(49)), /must be 50 bytes/);
  assert.throws(() => decodeCommitment(new Uint8Array(51)), /must be 50 bytes/);
});

test("deriveIntentId hashes commitment(50) ++ sender(32,left-padded) ++ nonce(u64)", () => {
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

  const preimage = new Uint8Array(50 + 32 + 8);
  preimage.set(encodeCommitment(commitment), 0);
  preimage.set(sender, 50 + (32 - sender.length)); // left-padded sender
  new DataView(preimage.buffer).setBigUint64(50 + 32, nonce); // nonce u64 BE
  const expected = keccak_256(preimage);

  assert.deepEqual(deriveIntentId(commitment, sender, nonce), expected);
  assert.equal(deriveIntentId(commitment, sender, nonce).length, 32);
});
