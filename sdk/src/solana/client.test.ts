import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BosphorSolanaClient,
  type SolanaChain,
  type SolanaIntentState,
} from "./client.js";
import { ProofTimeoutError, RelayerUploadError } from "../errors.js";
import type { FetchLike } from "../store-flow.js";
import { decodeIntentState, readSolanaProof, INTENT_STATE_LEN } from "./proof.js";
import type { BlobEncoding, ComputeBlob, Hex } from "../types.js";

// --- Test doubles -----------------------------------------------------------

const BLOB_ID: Hex = `0x${"aa".repeat(32)}`;
const INTENT_ID: Hex = `0x${"bb".repeat(32)}`;
const SIGNATURE = "5xSig111111111111111111111111111111111111111";
const END_EPOCH = 137n;

/** A deterministic stub computeBlob: never loads @mysten/walrus or a Sui RPC. */
const stubComputeBlob: ComputeBlob = async (data: Uint8Array): Promise<BlobEncoding> => ({
  blobId: BLOB_ID,
  size: data.length,
  encodingType: 0,
});

interface FakeChainOptions {
  /** Number of `readIntent` polls that return not-executed before it flips. */
  falsePollsBeforeExecuted?: number;
  /** If set, `readIntent` never reports executed (for the timeout path). */
  neverExecutes?: boolean;
  /** If set, `readIntent` returns null until executed (account not created yet). */
  nullUntilExecuted?: boolean;
}

/** A canned SolanaChain implementing the structural surface the client reads. */
function makeFakeChain(opts: FakeChainOptions = {}): {
  chain: SolanaChain;
  calls: { submit: number; read: number };
  lastSubmit: { dstEid?: number; nativeFee?: bigint };
} {
  const calls = { submit: 0, read: 0 };
  const lastSubmit: { dstEid?: number; nativeFee?: bigint } = {};
  let readPolls = 0;

  const chain: SolanaChain = {
    async submitIntent(fields) {
      calls.submit += 1;
      lastSubmit.dstEid = fields.dstEid;
      lastSubmit.nativeFee = fields.nativeFee;
      return { intentId: INTENT_ID, signature: SIGNATURE };
    },
    async readIntent(): Promise<SolanaIntentState | null> {
      calls.read += 1;
      const threshold = opts.falsePollsBeforeExecuted ?? 0;
      const executed = !opts.neverExecutes && readPolls >= threshold;
      readPolls += 1;

      if (opts.nullUntilExecuted && !executed) return null;
      return { executed, committedBlobId: BLOB_ID, endEpoch: executed ? END_EPOCH : 0n };
    },
  };

  return { chain, calls, lastSubmit };
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

test("store() runs encode -> submit -> upload -> awaitProof and returns verified result", async () => {
  const { chain, calls } = makeFakeChain();
  const { fetch, calls: fetchCalls } = makeFetch(200, '{"ok":true}');

  const client = new BosphorSolanaClient({
    chain,
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
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0], `https://relayer.test/blob/${INTENT_ID}`);
});

test("store() surfaces a relayer non-2xx as a RelayerUploadError with the reason", async () => {
  const { chain } = makeFakeChain();
  const { fetch } = makeFetch(422, "recomputed blob id does not match committed");

  const client = new BosphorSolanaClient({
    chain,
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
  const { chain } = makeFakeChain({ neverExecutes: true });

  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch: makeFetch(200).fetch,
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
  const { chain } = makeFakeChain({ neverExecutes: true });

  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch: makeFetch(200).fetch,
  });

  await assert.rejects(
    () => client.store(new Uint8Array([9]), { timeoutMs: 20, pollMs: 5 }),
    ProofTimeoutError,
  );
});

test("awaitProof polls until the intent reports executed", async () => {
  const { chain, calls } = makeFakeChain({ falsePollsBeforeExecuted: 2 });

  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch: makeFetch(200).fetch,
  });

  const { blobId, endEpoch } = await client.awaitProof(INTENT_ID, {
    timeoutMs: 1000,
    pollMs: 1,
  });

  assert.equal(blobId, BLOB_ID);
  assert.equal(endEpoch, END_EPOCH);
  assert.ok(calls.read >= 3, `expected at least 3 read polls, got ${calls.read}`);
});

test("awaitProof tolerates a null IntentState PDA until it is created and executed", async () => {
  const { chain, calls } = makeFakeChain({ falsePollsBeforeExecuted: 2, nullUntilExecuted: true });

  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch: makeFetch(200).fetch,
  });

  const { blobId, endEpoch } = await client.awaitProof(INTENT_ID, {
    timeoutMs: 1000,
    pollMs: 1,
  });

  assert.equal(blobId, BLOB_ID);
  assert.equal(endEpoch, END_EPOCH);
  assert.ok(calls.read >= 3);
});

test("submit forwards dstEid and nativeFee overrides to the chain", async () => {
  const { chain, lastSubmit } = makeFakeChain();

  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    nativeFee: 100n,
    computeBlob: stubComputeBlob,
    fetch: makeFetch(200).fetch,
  });

  const encoded = await client.encode(new Uint8Array([1, 2, 3]));
  await client.submit(encoded, { dstEid: 40161, nativeFee: 999n });

  assert.equal(lastSubmit.dstEid, 40161);
  assert.equal(lastSubmit.nativeFee, 999n);
});

test("encode rejects empty data and derives a deadline", async () => {
  const { chain } = makeFakeChain();
  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://relayer.test",
    dstEid: 40378,
    computeBlob: stubComputeBlob,
    fetch: makeFetch(200).fetch,
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

// --- Proof reader tests -----------------------------------------------------

/** Build a raw IntentState account image matching the Anchor layout. */
function buildIntentStateBytes(executed: boolean, endEpoch: bigint): Uint8Array {
  const data = new Uint8Array(INTENT_STATE_LEN);
  const view = new DataView(data.buffer);
  // Anchor IntentState discriminator (sha256("account:IntentState")[..8]).
  data.set(Uint8Array.of(0x5f, 0x7b, 0x9d, 0x72, 0x4a, 0x1d, 0xdd, 0x73), 0);
  data.set(Uint8Array.from({ length: 32 }, () => 0xaa), 8); // committed_blob_id
  view.setUint32(40, 3, true); // size
  view.setUint32(44, 5, true); // storage_epochs
  view.setBigUint64(48, 1_760_000_000n, true); // deadline
  data.set(Uint8Array.from({ length: 32 }, () => 0xcc), 56); // sender
  view.setBigUint64(88, 7n, true); // nonce
  data[96] = executed ? 1 : 0; // executed
  view.setBigUint64(97, endEpoch, true); // end_epoch
  data[105] = 254; // bump
  return data;
}

test("decodeIntentState reads the Anchor IntentState layout", () => {
  const bytes = buildIntentStateBytes(true, END_EPOCH);
  const decoded = decodeIntentState(bytes);

  assert.equal(decoded.committedBlobId, `0x${"aa".repeat(32)}`);
  assert.equal(decoded.size, 3);
  assert.equal(decoded.storageEpochs, 5);
  assert.equal(decoded.deadline, 1_760_000_000n);
  assert.equal(decoded.sender, `0x${"cc".repeat(32)}`);
  assert.equal(decoded.nonce, 7n);
  assert.equal(decoded.executed, true);
  assert.equal(decoded.endEpoch, END_EPOCH);
  assert.equal(decoded.bump, 254);
});

test("decodeIntentState rejects a wrong-length account rather than fabricating", () => {
  assert.throws(() => decodeIntentState(new Uint8Array(64)), /must be 106 bytes/);
});

test("readSolanaProof reduces raw bytes and decoded state to the proof triple", () => {
  const bytes = buildIntentStateBytes(true, 424242n);
  const fromBytes = readSolanaProof(bytes);
  assert.equal(fromBytes.executed, true);
  assert.equal(fromBytes.blobId, `0x${"aa".repeat(32)}`);
  assert.equal(fromBytes.endEpoch, 424242n);

  const fromState = readSolanaProof({
    executed: false,
    committedBlobId: BLOB_ID,
    endEpoch: 0n,
  });
  assert.equal(fromState.executed, false);
  assert.equal(fromState.blobId, BLOB_ID);
  assert.equal(fromState.endEpoch, 0n);
});

test("store() rejects immediately when the signal is already aborted (no submit)", async () => {
  const { chain, calls } = makeFakeChain({ neverExecutes: true });
  const { fetch } = makeFetch(200, '{"ok":true}');
  const client = new BosphorSolanaClient({
    chain,
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
  const { chain } = makeFakeChain({ neverExecutes: true });
  const { fetch } = makeFetch(200);
  const client = new BosphorSolanaClient({
    chain,
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
