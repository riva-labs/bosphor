import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  instructionDiscriminator,
  accountDiscriminator,
  eventDiscriminator,
  KNOWN_DISCRIMINATORS,
  encodeSubmitIntentData,
  encodeSetPeerData,
  encodeConfirmExecutionData,
  decodeIntentState,
  decodeIntentSubmittedIntentId,
  findIntentSubmittedIntentId,
} from "./program.js";

// The load-bearing check: our computed discriminators must equal the ones the
// compiled bosphor_adapter program actually checks. If Anchor ever changes the
// preimage, or a name drifts, this fails instead of production.
test("computed discriminators match the compiled program's ground truth", () => {
  for (const [name, hex] of Object.entries(KNOWN_DISCRIMINATORS.instruction)) {
    assert.equal(bytesToHex(instructionDiscriminator(name)), hex, `ix ${name}`);
  }
  for (const [name, hex] of Object.entries(KNOWN_DISCRIMINATORS.account)) {
    assert.equal(bytesToHex(accountDiscriminator(name)), hex, `account ${name}`);
  }
  for (const [name, hex] of Object.entries(KNOWN_DISCRIMINATORS.event)) {
    assert.equal(bytesToHex(eventDiscriminator(name)), hex, `event ${name}`);
  }
});

test("encodeSubmitIntentData lays out discriminator ++ borsh args", () => {
  const data = encodeSubmitIntentData({
    blobId: ("0x" + "ab".repeat(32)) as `0x${string}`,
    size: 1024,
    encodingType: 1,
    storageEpochs: 5,
    deadline: 1_760_000_000n,
    dstEid: 40378,
    options: Uint8Array.of(0xaa, 0xbb),
    nativeFee: 250n,
    escrowAmount: 1000n,
  });

  const expected =
    KNOWN_DISCRIMINATORS.instruction.submit_intent + // 8-byte disc
    "ab".repeat(32) + //                                 blobId
    "00040000" + //                                      size u32 LE (1024)
    "01" + //                                            encodingType
    "05000000" + //                                      storageEpochs u32 LE (5)
    "0078e768" + "00000000" + //                         deadline u64 LE (1760000000)
    "ba9d0000" + //                                      dstEid u32 LE (40378)
    "02000000" + "aabb" + //                             options: len 2 + bytes
    "fa00000000000000" + //                              nativeFee u64 LE (250)
    "e803000000000000"; //                               escrowAmount u64 LE (1000)

  assert.equal(bytesToHex(data), expected);
});

test("decodeIntentState round-trips a synthetic account", () => {
  const disc = hexToBytes(KNOWN_DISCRIMINATORS.account.IntentState);
  const parts: number[] = [...disc];
  parts.push(...hexToBytes("22".repeat(32))); // committed_blob_id
  parts.push(0x00, 0x04, 0x00, 0x00); //          size = 1024
  parts.push(0x05, 0x00, 0x00, 0x00); //          storage_epochs = 5
  parts.push(0x00, 0x78, 0xe7, 0x68, 0, 0, 0, 0); // deadline = 1760000000
  parts.push(...hexToBytes("33".repeat(32))); //  sender
  parts.push(0x07, 0, 0, 0, 0, 0, 0, 0); //       nonce = 7
  parts.push(0x01); //                            executed = true
  parts.push(0x09, 0, 0, 0, 0, 0, 0, 0); //       end_epoch = 9
  parts.push(0xff); //                            bump

  const s = decodeIntentState(Uint8Array.from(parts));
  assert.equal(s.committedBlobId, "0x" + "22".repeat(32));
  assert.equal(s.size, 1024);
  assert.equal(s.storageEpochs, 5);
  assert.equal(s.deadline, 1_760_000_000n);
  assert.equal(bytesToHex(s.sender), "33".repeat(32));
  assert.equal(s.nonce, 7n);
  assert.equal(s.executed, true);
  assert.equal(s.endEpoch, 9n);
  assert.equal(s.bump, 0xff);
});

test("decodeIntentState rejects a foreign account", () => {
  assert.throws(() => decodeIntentState(new Uint8Array(120)));
});

test("event intentId is extracted from a Program data log", () => {
  const disc = hexToBytes(KNOWN_DISCRIMINATORS.event.IntentSubmitted);
  const intentId = "44".repeat(32);
  const payload = Uint8Array.from([...disc, ...hexToBytes(intentId)]);
  assert.equal(decodeIntentSubmittedIntentId(payload), "0x" + intentId);

  const b64 = Buffer.from(payload).toString("base64");
  const logs = ["Program log: hi", `Program data: ${b64}`, "Program log: bye"];
  assert.equal(findIntentSubmittedIntentId(logs), "0x" + intentId);
  assert.equal(findIntentSubmittedIntentId(["Program log: none"]), null);
});

test("encodeSetPeerData lays out discriminator ++ eid ++ peer", () => {
  const data = encodeSetPeerData(40378, hexToBytes("55".repeat(32)));
  assert.equal(
    bytesToHex(data),
    KNOWN_DISCRIMINATORS.instruction.set_peer + "ba9d0000" + "55".repeat(32),
  );
});

test("encodeConfirmExecutionData lays out discriminator ++ intentId ++ blobId ++ endEpoch", () => {
  const data = encodeConfirmExecutionData(
    ("0x" + "66".repeat(32)) as `0x${string}`,
    ("0x" + "77".repeat(32)) as `0x${string}`,
    9n,
  );
  assert.equal(
    bytesToHex(data),
    KNOWN_DISCRIMINATORS.instruction.confirm_execution +
      "66".repeat(32) +
      "77".repeat(32) +
      "0900000000000000",
  );
});
