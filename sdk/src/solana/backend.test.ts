import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as web3 from "@solana/web3.js";
import { Keypair, Transaction } from "@solana/web3.js";
import { createDefaultSolanaChain } from "./backend.js";
import { createBosphorSolanaClientFromWallet } from "./endpoint-accounts.js";
import type { SolanaSubmitFields } from "./client.js";
import type { BlobEncoding } from "../types.js";

const FIELDS: SolanaSubmitFields = {
  blobId: `0x${"ab".repeat(32)}`,
  size: 3,
  encodingType: 0,
  storageEpochs: 5,
  deadline: 1_900_000_000n,
  dstEid: 40378,
  options: "0x00030100110100000000000000000000000000030d40",
  nativeFee: 10_000_000n,
  escrowAmount: 1_000n,
};

/** A read/send-only fake of the Connection surface the backend uses. */
function fakeConnection(opts: { confirmErr?: unknown } = {}) {
  const sent: Uint8Array[] = [];
  const connection = {
    getAccountInfo: async () => null,
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 1_000,
    }),
    sendRawTransaction: async (raw: Uint8Array) => {
      sent.push(raw);
      return "5igWallet";
    },
    confirmTransaction: async () => ({ value: { err: opts.confirmErr ?? null } }),
    getTransaction: async () => ({ meta: { logMessages: [] } }),
  };
  return { connection, sent };
}

/** A wallet-adapter style signer (Phantom, @solana/wallet-adapter): no secret key exposed. */
function fakeWallet() {
  const kp = Keypair.generate();
  const signed: Transaction[] = [];
  const wallet = {
    publicKey: kp.publicKey,
    async signTransaction<T>(tx: T): Promise<T> {
      signed.push(tx as Transaction);
      (tx as Transaction).partialSign(kp);
      return tx;
    },
  };
  return { wallet, signed, kp };
}

describe("createDefaultSolanaChain with a wallet-adapter signer", () => {
  it("has the wallet sign the submit, then sends and confirms the raw transaction", async () => {
    const { connection, sent } = fakeConnection();
    const { wallet, signed, kp } = fakeWallet();
    const chain = await createDefaultSolanaChain({ connection, wallet, web3, computeUnitLimit: 400_000 });

    const { intentId, signature } = await chain.submitIntent(FIELDS);

    assert.match(intentId, /^0x[0-9a-f]{64}$/);
    assert.equal(signature, "5igWallet");
    assert.equal(signed.length, 1, "the wallet signs exactly once");
    assert.equal(sent.length, 1);
    const tx = Transaction.from(sent[0]!);
    assert.ok(tx.feePayer?.equals(kp.publicKey), "the wallet pays the fee");
    assert.ok(tx.verifySignatures(), "the sent transaction carries the wallet signature");
    assert.equal(tx.instructions.length, 2, "compute budget + submit_intent");
  });

  it("works without a global Buffer (browser)", async () => {
    const { connection } = fakeConnection();
    const { wallet } = fakeWallet();
    const chain = await createDefaultSolanaChain({ connection, wallet, web3 });
    const g = globalThis as { Buffer?: unknown };
    const saved = g.Buffer;
    g.Buffer = undefined;
    try {
      const { signature } = await chain.submitIntent(FIELDS);
      assert.equal(signature, "5igWallet");
    } finally {
      g.Buffer = saved;
    }
  });

  it("fails loudly when the confirmed transaction errored", async () => {
    const { connection } = fakeConnection({ confirmErr: { InstructionError: [1, { Custom: 6001 }] } });
    const { wallet } = fakeWallet();
    const chain = await createDefaultSolanaChain({ connection, wallet, web3 });
    await assert.rejects(chain.submitIntent(FIELDS), /5igWallet failed.*6001/);
  });

  it("refuses a disconnected wallet (publicKey null)", async () => {
    const { connection } = fakeConnection();
    const wallet = { publicKey: null, signTransaction: async <T>(tx: T) => tx };
    await assert.rejects(createDefaultSolanaChain({ connection, wallet, web3 }), /not connected/);
  });

  it("refuses a wallet that is neither a Keypair nor a signer", async () => {
    const { connection } = fakeConnection();
    await assert.rejects(
      createDefaultSolanaChain({ connection, wallet: { publicKey: Keypair.generate().publicKey } as never, web3 }),
      /signTransaction/,
    );
  });

  it("keeps signing with a Keypair through sendAndConfirmTransaction", async () => {
    const { connection } = fakeConnection();
    const kp = Keypair.generate();
    const seen: unknown[][] = [];
    const spyWeb3 = {
      ...web3,
      sendAndConfirmTransaction: async (_c: unknown, _tx: unknown, signers: unknown[]) => {
        seen.push(signers);
        return "5igKeypair";
      },
    };
    const chain = await createDefaultSolanaChain({ connection, wallet: kp, web3: spyWeb3 });
    const { signature } = await chain.submitIntent(FIELDS);
    assert.equal(signature, "5igKeypair");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]![0], kp, "the Keypair itself signs");
  });
});

describe("createBosphorSolanaClientFromWallet", () => {
  it("builds a client whose store is signed by the wallet", async () => {
    const { connection, sent } = fakeConnection();
    const { wallet, signed } = fakeWallet();
    const stubBlob = async (d: Uint8Array): Promise<BlobEncoding> => ({
      blobId: `0x${"cd".repeat(32)}`,
      size: d.length,
      encodingType: 0,
    });
    const client = await createBosphorSolanaClientFromWallet({
      connection,
      wallet,
      web3,
      computeBlob: stubBlob,
      liveLzFee: false,
    });
    const encoded = await client.encode(new Uint8Array([1, 2, 3]));
    const { txHash } = await client.submit(encoded);
    assert.equal(txHash, "5igWallet");
    assert.equal(signed.length, 1);
    assert.equal(sent.length, 1);
  });
});
