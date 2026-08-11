import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { encodeCommitment, deriveIntentId } from "./commitment-codec.ts";

const vectorsPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../shared/parity/commitment-vectors.json",
);
const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  vectors: Array<{
    name: string;
    blobId: string;
    size: number;
    encodingType: number;
    storageEpochs: number;
    deadline: string;
    sender: string;
    nonce: string;
    commitment: string;
    intentId: string;
  }>;
};

// The reference codec must reproduce every frozen parity vector exactly. Any
// drift in the TypeScript reference (and therefore the shared vectors that
// Solidity and Move are pinned to) fails here immediately.
for (const v of vectors) {
  test(`parity vector "${v.name}": TS reproduces frozen commitment + intentId`, () => {
    const c = {
      blobId: hexToBytes(v.blobId),
      size: v.size,
      encodingType: v.encodingType,
      storageEpochs: v.storageEpochs,
      deadline: BigInt(v.deadline),
    };
    assert.equal(bytesToHex(encodeCommitment(c)), v.commitment);
    assert.equal(
      bytesToHex(deriveIntentId(c, hexToBytes(v.sender), BigInt(v.nonce))),
      v.intentId,
    );
  });
}
