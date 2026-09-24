import { test } from "node:test";
import assert from "node:assert/strict";
import { FORWARD_MESSAGE_LEN, LzSolanaSdkMissingError, quoteSolanaLzFee } from "./lz-fee.js";
import { BosphorSolanaClient, type SolanaChain, type SolanaSubmitFields } from "./client.js";
import { createBosphorSolanaClientFromKeypair } from "./endpoint-accounts.js";
import { TESTNET } from "../networks.js";
import type { FetchLike } from "../store-flow.js";
import type { BlobEncoding, ComputeBlob, Hex } from "../types.js";

const ADMIN = "Admin1111111111111111111111111111111111111";
const ENDPOINT = TESTNET.solana.lzEndpointProgram;

class FakeKey {
  constructor(readonly key: string) {}
  toBase58() {
    return this.key;
  }
  toBytes() {
    return new Uint8Array(32).fill(7);
  }
  static findProgramAddressSync(): [FakeKey, number] {
    return [new FakeKey("StorePda"), 255];
  }
}

/** Minimal fakes of the web3.js and LZ SDK surfaces quoteSolanaLzFee touches. */
function fakes(returnData: { programId: string; data: [string, string] } | null) {
  const seen: { payer?: string; params?: Record<string, unknown>; keys?: number } = {};
  const web3 = {
    PublicKey: class extends FakeKey {
      constructor(k: string | Uint8Array) {
        super(typeof k === "string" ? k : ADMIN);
      }
    },
    TransactionInstruction: class {
      constructor(readonly opts: { keys: unknown[] }) {
        seen.keys = opts.keys.length;
      }
    },
    TransactionMessage: class {
      constructor(readonly opts: { payerKey: FakeKey }) {
        seen.payer = opts.payerKey.toBase58();
      }
      compileToV0Message() {
        return {};
      }
    },
    VersionedTransaction: class {
      constructor(readonly m: unknown) {}
    },
  };
  (web3.PublicKey as unknown as { findProgramAddressSync: unknown }).findProgramAddressSync =
    FakeKey.findProgramAddressSync;
  const lzSdk = {
    EndpointProgram: {
      Endpoint: class {
        async getQuoteIXAccountMetaForCPI() {
          return [
            { pubkey: new FakeKey(ENDPOINT), isSigner: false, isWritable: false },
            { pubkey: new FakeKey("A"), isSigner: false, isWritable: false },
            { pubkey: new FakeKey("B"), isSigner: false, isWritable: true },
          ];
        }
      },
      instructions: {
        quoteInstructionDiscriminator: [1, 2, 3, 4, 5, 6, 7, 8],
        quoteStruct: {
          serialize(args: { params: Record<string, unknown> }) {
            seen.params = args.params;
            return [new Uint8Array(8)];
          },
        },
      },
    },
    UlnProgram: { Uln: class {} },
  };
  const connection = {
    async getAccountInfo() {
      return { data: new Uint8Array(80) };
    },
    async getLatestBlockhash() {
      return { blockhash: "hash" };
    },
    async simulateTransaction() {
      return { value: { err: null, logs: [], returnData } };
    },
  };
  return { web3, lzSdk, connection, seen };
}

// 5_911_260 lamports as MessagingFee { native_fee u64 LE, lz_token_fee u64 LE }, base64.
const FEE_B64 = btoa(String.fromCharCode(0xdc, 0x32, 0x5a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0));

test("quoteSolanaLzFee simulates the endpoint quote and decodes the native fee", async () => {
  const { web3, lzSdk, connection, seen } = fakes({ programId: ENDPOINT, data: [FEE_B64, "base64"] });
  const fee = await quoteSolanaLzFee({ connection, lzSdk, web3 });
  assert.equal(fee, 5_911_260n);
  assert.equal(seen.payer, ADMIN); // defaults to the Store admin read on-chain
  assert.equal(seen.keys, 2); // the endpoint program meta is dropped
  assert.equal((seen.params?.message as Uint8Array).length, FORWARD_MESSAGE_LEN);
  assert.equal(seen.params?.dstEid, TESTNET.sui.eid);
});

test("quoteSolanaLzFee uses an explicit simulation payer when given", async () => {
  const { web3, lzSdk, connection, seen } = fakes({ programId: ENDPOINT, data: [FEE_B64, "base64"] });
  await quoteSolanaLzFee({ connection, lzSdk, web3, payer: "Payer222" });
  assert.equal(seen.payer, "Payer222");
});

test("quoteSolanaLzFee fails loudly when the simulation returns no data", async () => {
  const { web3, lzSdk, connection } = fakes(null);
  await assert.rejects(quoteSolanaLzFee({ connection, lzSdk, web3 }), /simulation failed/);
});

test("quoteSolanaLzFee raises LzSolanaSdkMissingError when the optional peer is absent", async () => {
  // The SDK's own test environment does not install the LayerZero Solana SDK.
  await assert.rejects(quoteSolanaLzFee({ connection: {} }), LzSolanaSdkMissingError);
});

// --- client wiring --------------------------------------------------------

const BLOB_ID: Hex = `0x${"aa".repeat(32)}`;
const computeBlob: ComputeBlob = async (d: Uint8Array): Promise<BlobEncoding> => ({
  blobId: BLOB_ID,
  size: d.length,
  encodingType: 0,
});

function quoteFetch(bodies: string[]): FetchLike {
  return async (_url, init) => {
    const req = JSON.parse(new TextDecoder().decode(init.body)) as { forwardLzFeeNative: string };
    bodies.push(req.forwardLzFeeNative);
    const fwd = BigInt(req.forwardLzFeeNative);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          originToken: "SOL",
          escrowNative: "1000",
          forwardNative: fwd.toString(),
          totalNative: (1000n + fwd).toString(),
          breakdown: {},
        }),
    };
  };
}

function chainRecording(): { chain: SolanaChain; submitted: SolanaSubmitFields[] } {
  const submitted: SolanaSubmitFields[] = [];
  return {
    submitted,
    chain: {
      async submitIntent(f) {
        submitted.push(f);
        return { intentId: `0x${"bb".repeat(32)}`, signature: "sig" };
      },
      async readIntent() {
        return null;
      },
    },
  };
}

test("priceQuote uses the live LZ fee when a quoter is configured", async () => {
  const bodies: string[] = [];
  const { chain, submitted } = chainRecording();
  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://r",
    dstEid: 1,
    nativeFee: 10_000_000n,
    quoteLzFee: async () => 5_911_260n,
    computeBlob,
    fetch: quoteFetch(bodies),
  });
  const encoded = await client.encode(new Uint8Array([1]));
  const quote = await client.priceQuote(encoded);
  assert.equal(bodies[0], "5911260");
  assert.equal(quote.forwardNative, 5_911_260n);
  assert.equal(quote.forwardIsUpperBound, false);
  // The submit still passes the (larger) cap as the LZ fee bound.
  await client.submitPaid(encoded, quote);
  assert.equal(submitted[0]?.nativeFee, 10_000_000n);
  assert.equal(submitted[0]?.escrowAmount, 1000n);
});

test("priceQuote flags the cap as an upper bound without a live quoter", async () => {
  const bodies: string[] = [];
  const { chain } = chainRecording();
  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://r",
    dstEid: 1,
    nativeFee: 10_000_000n,
    quoteLzFee: async () => null,
    computeBlob,
    fetch: quoteFetch(bodies),
  });
  const quote = await client.priceQuote(await client.encode(new Uint8Array([1])));
  assert.equal(bodies[0], "10000000");
  assert.equal(quote.forwardIsUpperBound, true);
});

test("submitPaid raises the LZ fee bound when the live quote exceeds the cap", async () => {
  const { chain, submitted } = chainRecording();
  const client = new BosphorSolanaClient({
    chain,
    relayerUrl: "https://r",
    dstEid: 1,
    nativeFee: 1_000n,
    quoteLzFee: async () => 5_000n,
    computeBlob,
    fetch: quoteFetch([]),
  });
  const encoded = await client.encode(new Uint8Array([1]));
  await client.submitPaid(encoded, await client.priceQuote(encoded));
  assert.equal(submitted[0]?.nativeFee, 5_000n);
});

test("the Keypair helper falls back to a flagged cap when the LZ SDK peer is absent", async () => {
  const bodies: string[] = [];
  const { chain } = chainRecording();
  const client = await createBosphorSolanaClientFromKeypair({
    connection: {},
    wallet: { publicKey: "Payer" },
    chain,
    computeBlob,
    fetch: quoteFetch(bodies),
  });
  const quote = await client.priceQuote(await client.encode(new Uint8Array([1])));
  assert.equal(quote.forwardIsUpperBound, true);
  assert.equal(bodies[0], TESTNET.solana.nativeFee.toString());
});
