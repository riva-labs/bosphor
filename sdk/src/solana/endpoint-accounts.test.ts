import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PAYER_PLACEHOLDER,
  TESTNET_SEND_ACCOUNTS,
  createBosphorSolanaClientFromKeypair,
  resolveEndpointAccounts,
  testnetEndpointAccounts,
} from "./endpoint-accounts.js";
import type { SolanaChain, SolanaSubmitFields } from "./client.js";
import { TESTNET } from "../networks.js";
import type { FetchLike } from "../store-flow.js";
import type { BlobEncoding, ComputeBlob, Hex } from "../types.js";

const PAYER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const STORE_PDA = "Gn2Lib6i7iqEibZRjvp3pcDm8cJfCHgTDF9Aek1XnPrE";

test("TESTNET_SEND_ACCOUNTS has one payer slot and the Store PDA at index 1", () => {
  assert.equal(TESTNET_SEND_ACCOUNTS.length, 26);
  assert.equal(TESTNET_SEND_ACCOUNTS[0]?.pubkey, TESTNET.solana.lzEndpointProgram);
  assert.equal(TESTNET_SEND_ACCOUNTS[1]?.pubkey, STORE_PDA);
  assert.equal(TESTNET_SEND_ACCOUNTS.filter((a) => a.pubkey === PAYER_PLACEHOLDER).length, 1);
});

test("testnetEndpointAccounts substitutes the payer and marks nothing as signer", () => {
  const metas = testnetEndpointAccounts(PAYER);
  assert.equal(metas.length, TESTNET_SEND_ACCOUNTS.length);
  const payerSlot = metas[13];
  assert.deepEqual(payerSlot, { pubkey: PAYER, isSigner: false, isWritable: true });
  assert.ok(metas.every((m) => m.pubkey !== PAYER_PLACEHOLDER && m.isSigner === false));
  // Accepts a PublicKey-like object too.
  assert.equal(testnetEndpointAccounts({ toBase58: () => PAYER })[13]?.pubkey, PAYER);
});

test("resolveEndpointAccounts queries the LZ SDK for the preset pathway", async () => {
  class PublicKey {
    constructor(readonly key: string) {}
    toBase58() {
      return this.key;
    }
    toBytes() {
      return new Uint8Array(32).fill(7);
    }
    static findProgramAddressSync(_seeds: Uint8Array[], _program: unknown): [PublicKey, number] {
      return [new PublicKey(STORE_PDA), 255];
    }
  }
  let seenPath: { sender: string; dstEid: number; receiver: string } | undefined;
  let seenEndpoint = "";
  const lzSdk = {
    EndpointProgram: {
      Endpoint: class {
        constructor(id: PublicKey) {
          seenEndpoint = id.toBase58();
        }
        async getSendIXAccountMetaForCPI(
          _conn: unknown,
          payer: PublicKey,
          path: { sender: string; dstEid: number; receiver: string },
        ) {
          seenPath = path;
          return [{ pubkey: payer, isSigner: false, isWritable: true }];
        }
      },
    },
    UlnProgram: { Uln: class {} },
  };

  const metas = await resolveEndpointAccounts({
    connection: {},
    payer: PAYER,
    lzSdk,
    web3: { PublicKey },
  });
  assert.equal(seenEndpoint, TESTNET.solana.lzEndpointProgram);
  assert.equal(seenPath?.dstEid, TESTNET.sui.eid);
  assert.equal(seenPath?.receiver, TESTNET.sui.packageId);
  assert.equal(seenPath?.sender, "0x" + "07".repeat(32));
  assert.deepEqual(metas, [{ pubkey: PAYER, isSigner: false, isWritable: true }]);
});

test("createBosphorSolanaClientFromKeypair wires the preset fee, options, and relayer", async () => {
  const BLOB_ID: Hex = `0x${"aa".repeat(32)}`;
  const computeBlob: ComputeBlob = async (d: Uint8Array): Promise<BlobEncoding> => ({
    blobId: BLOB_ID,
    size: d.length,
    encodingType: 0,
  });
  let submitted: SolanaSubmitFields | undefined;
  const chain: SolanaChain = {
    async submitIntent(fields) {
      submitted = fields;
      return { intentId: `0x${"bb".repeat(32)}`, signature: "sig" };
    },
    async readIntent() {
      return null;
    },
  };
  let quoteBody = "";
  let quoteUrl = "";
  const fetchFn: FetchLike = async (url, init) => {
    quoteUrl = url;
    quoteBody = new TextDecoder().decode(init.body);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          originToken: "SOL",
          escrowNative: "5000",
          forwardNative: "0",
          totalNative: "5000",
          breakdown: {},
        }),
    };
  };

  const client = await createBosphorSolanaClientFromKeypair({
    connection: {},
    wallet: { publicKey: PAYER },
    chain,
    computeBlob,
    fetch: fetchFn,
  });
  const encoded = await client.encode(new Uint8Array([1, 2]));
  const quote = await client.priceQuote(encoded);
  await client.submitPaid(encoded, quote);

  assert.equal(quoteUrl, `${TESTNET.relayerUrl}/quote`);
  assert.equal(JSON.parse(quoteBody).originToken, "SOL");
  assert.equal(submitted?.dstEid, TESTNET.sui.eid);
  assert.equal(submitted?.options, TESTNET.solana.lzOptions);
  assert.equal(submitted?.nativeFee, TESTNET.solana.nativeFee);
  assert.equal(submitted?.escrowAmount, 5000n);
});

test("createBosphorSolanaClientFromKeypair rejects a missing wallet", async () => {
  await assert.rejects(
    createBosphorSolanaClientFromKeypair({ connection: {}, wallet: undefined as never }),
    /wallet/,
  );
});
