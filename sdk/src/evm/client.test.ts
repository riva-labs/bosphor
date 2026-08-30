import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BosphorEvmClient,
  decodeProofEndEpoch,
  type AdapterContract,
  type EvmTransactionReceipt,
} from "./client.js";
import { fromEthersContract, type EthersContractLike } from "./adapter.js";
import { ProofTimeoutError, RelayerUploadError } from "../errors.js";
import type { FetchLike } from "../store-flow.js";
import type { BlobEncoding, ComputeBlob, Hex } from "../types.js";

// --- Test doubles -----------------------------------------------------------

const BLOB_ID: Hex = `0x${"aa".repeat(32)}`;
const INTENT_ID: Hex = `0x${"bb".repeat(32)}`;
const END_EPOCH = 137n;

/** A deterministic stub computeBlob: never loads @mysten/walrus or a Sui RPC. */
const stubComputeBlob: ComputeBlob = async (data: Uint8Array): Promise<BlobEncoding> => ({
  blobId: BLOB_ID,
  size: data.length,
  encodingType: 0,
});

/** The proof bytes the adapter would emit: abi.encode(blobId, endEpoch). */
function encodeProof(blobId: Hex, endEpoch: bigint): Hex {
  const epochHex = endEpoch.toString(16).padStart(64, "0");
  return `0x${blobId.slice(2)}${epochHex}`;
}

interface FakeAdapterOptions {
  /** Number of `executed` polls that return false before it flips to true. */
  falsePollsBeforeExecuted?: number;
  /** If set, `executed` never returns true (for the timeout path). */
  neverExecutes?: boolean;
}

/** A canned adapter implementing the structural surface the client reads. */
function makeFakeAdapter(opts: FakeAdapterOptions = {}): {
  adapter: AdapterContract;
  calls: { submit: number; quote: number; executed: number };
} {
  const calls = { submit: 0, quote: 0, executed: 0 };
  let executedPolls = 0;

  const receipt: EvmTransactionReceipt = {
    logs: [{ topics: ["0xIntentSubmitted"], data: "0x" }],
  };

  const adapter: AdapterContract = {
    async submitIntent() {
      calls.submit += 1;
      return {
        hash: "0xdeadbeef",
        async wait() {
          return receipt;
        },
      };
    },
    async quote() {
      calls.quote += 1;
      return { nativeFee: 12345n, lzTokenFee: 0n };
    },
    async executed() {
      calls.executed += 1;
      if (opts.neverExecutes) return false;
      const threshold = opts.falsePollsBeforeExecuted ?? 0;
      const done = executedPolls >= threshold;
      executedPolls += 1;
      return done;
    },
    async committedBlobId() {
      return BLOB_ID;
    },
    async queryProof() {
      return encodeProof(BLOB_ID, END_EPOCH);
    },
    async getIntentId() {
      return INTENT_ID;
    },
    async nonces() {
      return 0n;
    },
    interface: {
      parseLog(log) {
        if (log.topics[0] === "0xIntentSubmitted") {
          // ethers exposes args as both named and positional; mimic that shape.
          const args = Object.assign([INTENT_ID], { intentId: INTENT_ID }) as unknown as Record<
            string,
            unknown
          > &
            ArrayLike<unknown>;
          return { name: "IntentSubmitted", args };
        }
        return null;
      },
    },
  };

  return { adapter, calls };
}

/** A fetch stub returning a fixed status. */
function makeFetch(status: number, body = ""): { fetch: FetchLike; calls: string[] } {
  const callsList: string[] = [];
  const fetch: FetchLike = async (url) => {
    callsList.push(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      async text() {
        return body;
      },
    };
  };
  return { fetch, calls: callsList };
}

// --- Tests ------------------------------------------------------------------

test("store() runs encode -> quote -> submit -> upload -> awaitProof and returns verified result", async () => {
  const { adapter, calls } = makeFakeAdapter();
  const { fetch, calls: fetchCalls } = makeFetch(200, '{"intentId":"x","blobId":"y","size":3}');

  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test/",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });

  const result = await client.store(new Uint8Array([1, 2, 3]), { pollMs: 1 });

  assert.equal(result.intentId, INTENT_ID);
  assert.equal(result.blobId, BLOB_ID);
  assert.equal(result.endEpoch, END_EPOCH);

  assert.equal(calls.submit, 1);
  assert.equal(calls.quote, 1);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0], `https://relayer.test/blob/${INTENT_ID}`);
});

test("store() surfaces a relayer non-2xx as a RelayerUploadError with the reason", async () => {
  const { adapter } = makeFakeAdapter();
  const { fetch } = makeFetch(422, "recomputed blob id does not match committed");

  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });

  await assert.rejects(
    () => client.store(new Uint8Array([1, 2, 3]), { pollMs: 1 }),
    (err: unknown) => {
      assert.ok(err instanceof RelayerUploadError);
      assert.equal(err.status, 422);
      assert.equal(err.intentId, INTENT_ID);
      assert.match(err.message, /does not match committed/);
      return true;
    },
  );
});

test("awaitProof throws a typed ProofTimeoutError when the intent never executes", async () => {
  const { adapter } = makeFakeAdapter({ neverExecutes: true });
  const { fetch } = makeFetch(200);

  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });

  await assert.rejects(
    () => client.awaitProof(INTENT_ID, { timeoutMs: 20, pollMs: 5 }),
    (err: unknown) => {
      assert.ok(err instanceof ProofTimeoutError);
      assert.equal(err.intentId, INTENT_ID);
      assert.match(err.message, /did not execute within 20ms/);
      return true;
    },
  );
});

test("store() times out via awaitProof when execution never confirms", async () => {
  const { adapter } = makeFakeAdapter({ neverExecutes: true });
  const { fetch } = makeFetch(200);

  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });

  await assert.rejects(
    () => client.store(new Uint8Array([9]), { timeoutMs: 20, pollMs: 5 }),
    ProofTimeoutError,
  );
});

test("awaitProof polls until executed becomes true", async () => {
  const { adapter, calls } = makeFakeAdapter({ falsePollsBeforeExecuted: 2 });
  const { fetch } = makeFetch(200);

  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });

  const { blobId, endEpoch } = await client.awaitProof(INTENT_ID, {
    timeoutMs: 1000,
    pollMs: 1,
  });

  assert.equal(blobId, BLOB_ID);
  assert.equal(endEpoch, END_EPOCH);
  assert.ok(calls.executed >= 3, `expected at least 3 executed polls, got ${calls.executed}`);
});

test("encode rejects empty data and derives a deadline", async () => {
  const { adapter } = makeFakeAdapter();
  const { fetch } = makeFetch(200);
  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
    deadlineSeconds: 100,
  });

  await assert.rejects(() => client.encode(new Uint8Array([])), /cannot store empty data/);

  const before = BigInt(Math.floor(Date.now() / 1000));
  const encoded = await client.encode(new Uint8Array([1, 2, 3, 4]), { epochs: 9 });
  assert.equal(encoded.blobId, BLOB_ID);
  assert.equal(encoded.size, 4);
  assert.equal(encoded.storageEpochs, 9);
  assert.ok(encoded.deadline >= before + 100n);
});

test("decodeProofEndEpoch extracts the uint256 end epoch from abi.encode(bytes32,uint256)", () => {
  const proof = encodeProof(BLOB_ID, 424242n);
  assert.equal(decodeProofEndEpoch(proof), 424242n);
  assert.throws(() => decodeProofEndEpoch("0x1234" as Hex), /must be 64 bytes/);
});

test("store() rejects immediately when the signal is already aborted (no on-chain calls)", async () => {
  const { adapter, calls } = makeFakeAdapter({ neverExecutes: true });
  const { fetch } = makeFetch(200);
  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test/",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });

  const ac = new AbortController();
  ac.abort(new Error("cancelled by caller"));

  await assert.rejects(
    () => client.store(new Uint8Array([1, 2, 3]), { pollMs: 1, signal: ac.signal }),
    /cancelled by caller/,
  );
  assert.equal(calls.submit, 0, "no intent should be submitted after an abort");
});

test("awaitProof() rejects with the abort reason when the signal fires mid-poll", async () => {
  const { adapter } = makeFakeAdapter({ neverExecutes: true });
  const { fetch } = makeFetch(200);
  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test/",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });

  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("stop waiting")), 5);

  await assert.rejects(
    () => client.awaitProof(INTENT_ID, { pollMs: 2, timeoutMs: 60_000, signal: ac.signal }),
    /stop waiting/,
  );
});

test("store() and submit() surface the origin submit tx hash", async () => {
  const { adapter } = makeFakeAdapter();
  const { fetch } = makeFetch(200, '{"intentId":"x","blobId":"y","size":3}');
  const client = new BosphorEvmClient({
    adapter,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch,
  });
  const result = await client.store(new Uint8Array([1, 2, 3]), { pollMs: 1 });
  assert.equal(result.txHash, "0xdeadbeef");
});

test("fromEthersContract delegates methods and wires queryProof from the event log", async () => {
  let queried = false;
  const contract: EthersContractLike = {
    async submitIntent() {
      return { hash: "0xabc", async wait() { return { logs: [] }; } };
    },
    async quote() {
      return { nativeFee: 7n, lzTokenFee: 0n };
    },
    async executed() {
      return true;
    },
    async committedBlobId() {
      return BLOB_ID;
    },
    interface: {
      parseLog() {
        return null;
      },
    },
    filters: {
      IntentExecuted(intentId) {
        return { intentId };
      },
    },
    async queryFilter() {
      queried = true;
      return [{ args: { proof: encodeProof(BLOB_ID, END_EPOCH) } }];
    },
  };

  const adapter = fromEthersContract(contract, { proofLookbackBlocks: 10 });
  assert.equal(await adapter.executed(INTENT_ID), true);
  assert.equal(await adapter.committedBlobId(INTENT_ID), BLOB_ID);
  const proof = await adapter.queryProof!(INTENT_ID);
  assert.ok(queried, "queryProof should call the contract's queryFilter");
  assert.equal(decodeProofEndEpoch(proof!), END_EPOCH);
  // Optional members the contract does not expose stay undefined.
  assert.equal(adapter.nonces, undefined);
  assert.equal(adapter.getIntentId, undefined);
});
