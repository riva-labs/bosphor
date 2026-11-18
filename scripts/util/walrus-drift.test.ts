import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { driftVerdict, parsePublished, walrusPin } from "./walrus-drift.js";

const LOCK = `
[pinned.mainnet.walrus]
source = { git = "https://github.com/MystenLabs/walrus.git", subdir = "mainnet-contracts/walrus", rev = "544d3cf71b4c043759657e5622508570999fddd0" }
use_environment = "mainnet"

[pinned.testnet.walrus]
source = { git = "https://github.com/MystenLabs/walrus.git", subdir = "testnet-contracts/walrus", rev = "2e35317046cf5f6e7274fe24f31431d832d2be25" }
use_environment = "testnet"
`;

const PUBLISHED = `
[published.testnet]
chain-id = "4c78adac"
original-id = "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66"
published-at = "0x7d3b2086808a62bbc44d18c6b1d407973d77dd26946735873092c2f5650b4611"
version = 4
`;

describe("walrusPin", () => {
  it("reads the pinned walrus source for one environment from the executor Move.lock", () => {
    assert.deepEqual(walrusPin(LOCK, "testnet"), {
      subdir: "testnet-contracts/walrus",
      rev: "2e35317046cf5f6e7274fe24f31431d832d2be25",
    });
    assert.equal(walrusPin(LOCK, "mainnet").subdir, "mainnet-contracts/walrus");
  });

  it("fails loudly when the lock has no walrus pin for the environment", () => {
    assert.throws(() => walrusPin("[move]\nversion = 4\n", "testnet"), /no walrus pin/);
  });
});

describe("parsePublished", () => {
  it("reads original-id, published-at and version for one environment", () => {
    assert.deepEqual(parsePublished(PUBLISHED, "testnet"), {
      originalId: "0xd84704c17fc870b8764832c535aa6b11f21a95cd6f5bb38a9b07d2cf42220c66",
      publishedAt: "0x7d3b2086808a62bbc44d18c6b1d407973d77dd26946735873092c2f5650b4611",
      version: 4,
    });
  });

  it("fails loudly when the environment is missing", () => {
    assert.throws(() => parsePublished(PUBLISHED, "mainnet"), /no \[published.mainnet\]/);
  });
});

describe("driftVerdict", () => {
  const linked = parsePublished(PUBLISHED, "testnet");

  it("is ok while the chain's latest Walrus package is the one we link", () => {
    const v = driftVerdict(linked, { address: linked.publishedAt, version: 4 });
    assert.equal(v.ok, true);
  });

  it("flags an upgrade past the linked package, naming both versions", () => {
    const v = driftVerdict(linked, { address: "0x" + "ab".repeat(32), version: 5 });
    assert.equal(v.ok, false);
    assert.match(v.message, /v4/);
    assert.match(v.message, /v5/);
  });

  it("treats address formatting differences (case, leading zeros) as the same package", () => {
    const v = driftVerdict(
      { ...linked, publishedAt: "0x0abc" },
      { address: "0x" + "0".repeat(61) + "ABC", version: 4 },
    );
    assert.equal(v.ok, true);
  });
});
