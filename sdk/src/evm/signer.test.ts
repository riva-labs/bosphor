import { test } from "node:test";
import assert from "node:assert/strict";
import { ADAPTER_ABI, EscrowStatus } from "./abi.js";
import { connectAdapter, createBosphorClientFromSigner, type EthersModuleLike } from "./signer.js";
import { TESTNET, type BosphorNetwork } from "../networks.js";
import type { FetchLike } from "../store-flow.js";
import type { BlobEncoding, ComputeBlob, Hex } from "../types.js";

const BLOB_ID: Hex = `0x${"aa".repeat(32)}`;
const stubComputeBlob: ComputeBlob = async (data: Uint8Array): Promise<BlobEncoding> => ({
  blobId: BLOB_ID,
  size: data.length,
  encodingType: 0,
});

interface Seen {
  address?: string;
  abi?: readonly string[];
  runner?: unknown;
  quoteArgs?: unknown[];
}

/** A stub `ethers` module whose Contract records how it was built and called. */
function stubEthers(seen: Seen): EthersModuleLike {
  class Contract {
    interface = { parseLog: () => null };
    filters = { IntentExecuted: (id: Hex) => ({ id }) };
    constructor(address: string, abi: readonly string[], runner?: unknown) {
      seen.address = address;
      seen.abi = abi;
      seen.runner = runner;
    }
    async quote(...args: unknown[]) {
      seen.quoteArgs = args;
      return { nativeFee: 300n, lzTokenFee: 0n };
    }
    async executed() {
      return false;
    }
    async committedBlobId() {
      return BLOB_ID;
    }
    async submitIntent() {
      throw new Error("not used");
    }
    async queryFilter() {
      return [];
    }
  }
  return { Contract };
}

const SIGNER = { tag: "signer" };

test("ADAPTER_ABI covers the calls, events, and errors an integrator needs", () => {
  const joined = ADAPTER_ABI.join("\n");
  for (const name of [
    "function submitIntent(",
    "function quote(",
    "function executed(",
    "function committedBlobId(",
    "function getEscrow(",
    "function refund(",
    "function nonces(",
    "function getIntentId(",
    "event IntentSubmitted(",
    "event IntentExecuted(",
    "event EscrowReleased(",
    "error InsufficientPayment()",
    "error BlobIdMismatch()",
  ]) {
    assert.ok(joined.includes(name), `ADAPTER_ABI is missing ${name}`);
  }
  assert.deepEqual(EscrowStatus, { None: 0, Pending: 1, Released: 2, Refunded: 3 });
});

test("connectAdapter binds the TESTNET adapter address with the bundled ABI", async () => {
  const seen: Seen = {};
  const adapter = await connectAdapter(SIGNER, { ethers: stubEthers(seen) });
  assert.equal(seen.address, TESTNET.evm.adapterAddress);
  assert.equal(seen.abi, ADAPTER_ABI);
  assert.equal(seen.runner, SIGNER);
  assert.equal(typeof adapter.queryProof, "function");
});

test("connectAdapter honors an address override", async () => {
  const seen: Seen = {};
  await connectAdapter(SIGNER, { ethers: stubEthers(seen), address: "0x1234" });
  assert.equal(seen.address, "0x1234");
});

test("connectAdapter rejects a missing signer", async () => {
  await assert.rejects(connectAdapter(undefined, { ethers: stubEthers({}) }), /Signer/);
});

test("createBosphorClientFromSigner wires the preset dstEid, LZ options, and relayer", async () => {
  const seen: Seen = {};
  let quoteUrl = "";
  const fetchFn: FetchLike = async (url) => {
    quoteUrl = url;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          originToken: "ETH",
          escrowNative: "1000",
          forwardNative: "300",
          totalNative: "1300",
          breakdown: {},
        }),
    };
  };
  const client = await createBosphorClientFromSigner(SIGNER, {
    ethers: stubEthers(seen),
    computeBlob: stubComputeBlob,
    fetch: fetchFn,
  });

  const encoded = await client.encode(new Uint8Array([1, 2, 3]));
  const fee = await client.quote(encoded);
  assert.equal(fee.nativeFee, 300n);
  assert.equal(seen.quoteArgs?.[0], TESTNET.sui.eid);
  assert.equal(seen.quoteArgs?.[6], TESTNET.evm.lzOptions);

  const quote = await client.priceQuote(encoded);
  assert.equal(quoteUrl, `${TESTNET.relayerUrl}/quote`);
  assert.equal(quote.totalNative, 1300n);
});

test("createBosphorClientFromSigner accepts a custom network preset", async () => {
  const seen: Seen = {};
  const custom: BosphorNetwork = {
    ...TESTNET,
    relayerUrl: "http://localhost:3000",
    evm: { ...TESTNET.evm, adapterAddress: "0xabc", lzOptions: "0x0003ff" },
    sui: { ...TESTNET.sui, eid: 1 },
  };
  const client = await createBosphorClientFromSigner(SIGNER, {
    network: custom,
    ethers: stubEthers(seen),
    computeBlob: stubComputeBlob,
  });
  await client.quote(await client.encode(new Uint8Array([1])));
  assert.equal(seen.address, "0xabc");
  assert.equal(seen.quoteArgs?.[0], 1);
  assert.equal(seen.quoteArgs?.[6], "0x0003ff");
});
