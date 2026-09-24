import { test } from "node:test";
import assert from "node:assert/strict";
import { TESTNET, networks, walrusBlobUrl, blobIdToBase64Url } from "./networks.js";
import { base64UrlToBytes32Hex } from "./blob.js";

test("TESTNET preset carries the live testnet deployment", () => {
  assert.equal(networks.testnet, TESTNET);
  assert.equal(TESTNET.relayerUrl, "https://api.bosphor.xyz/testnet");
  assert.equal(TESTNET.sui.eid, 40378);
  assert.equal(TESTNET.evm.eid, 40161);
  assert.equal(TESTNET.evm.chainId, 11155111);
  assert.equal(TESTNET.evm.rpcUrl, "https://ethereum-sepolia-rpc.publicnode.com");
  assert.equal(TESTNET.evm.adapterAddress, "0x3296686Fc61076d27488278c1da5468E1e0A7156");
  assert.equal(TESTNET.solana.eid, 40168);
  assert.equal(TESTNET.solana.programId, "7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF");
  assert.equal(TESTNET.walrusNetwork, "testnet");
});

test("TESTNET LZ options are non-empty type-3 options (empty 0x reverts the quote)", () => {
  for (const opts of [TESTNET.evm.lzOptions, TESTNET.solana.lzOptions]) {
    assert.match(opts, /^0x0003/);
  }
});

test("TESTNET contains no superseded deployment addresses", () => {
  const json = JSON.stringify(TESTNET, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.ok(!json.toLowerCase().includes("0x3c8b7a1c684dd10aed6bb392651c678f1ce05e10"));
  assert.ok(!json.includes("relayer.bosphor.xyz"));
});

test("blobIdToBase64Url inverts base64UrlToBytes32Hex", () => {
  for (const id of [
    "qineIE9eC8z5CTaTsILV-LL_8VwRVCK-lKZftG7B4ik",
    "C8PS3IT9ICqfchEnlef3gJfjLGm3clG-_tQp87R_hUM",
  ]) {
    assert.equal(blobIdToBase64Url(base64UrlToBytes32Hex(id)), id);
  }
});

test("blobIdToBase64Url rejects malformed ids", () => {
  assert.throws(() => blobIdToBase64Url("0x1234"), /32-byte/);
});

test("walrusBlobUrl builds a testnet aggregator URL", () => {
  const hex = base64UrlToBytes32Hex("qineIE9eC8z5CTaTsILV-LL_8VwRVCK-lKZftG7B4ik");
  assert.equal(
    walrusBlobUrl(hex),
    "https://aggregator.walrus-testnet.walrus.space/v1/blobs/qineIE9eC8z5CTaTsILV-LL_8VwRVCK-lKZftG7B4ik",
  );
});
