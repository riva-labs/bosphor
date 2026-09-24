import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import { BosphorSolanaClient, type SolanaChain, type SolanaEscrowState } from "./client.js";
import { decodeEscrowVault, encodeRefundEscrowData } from "./program.js";
import type { Hex } from "../types.js";

const INTENT_ID: Hex = `0x${"bb".repeat(32)}`;

function disc(preimage: string): Uint8Array {
  return sha256(new TextEncoder().encode(preimage)).slice(0, 8);
}

test("encodeRefundEscrowData is the Anchor discriminator followed by the intent id", () => {
  const data = encodeRefundEscrowData(INTENT_ID);
  assert.equal(data.length, 40);
  assert.deepEqual(data.subarray(0, 8), disc("global:refund_escrow"));
  assert.deepEqual(data.subarray(8), new Uint8Array(32).fill(0xbb));
  assert.throws(() => encodeRefundEscrowData("0x1234"), /32 bytes/);
});

test("decodeEscrowVault reads the EscrowVault layout and checks the discriminator", () => {
  const buf = new Uint8Array(8 + 32 + 32 + 8 + 8 + 1 + 1);
  buf.set(disc("account:EscrowVault"), 0);
  buf.fill(1, 8, 40); // payer
  buf.fill(2, 40, 72); // beneficiary
  const view = new DataView(buf.buffer);
  view.setBigUint64(72, 22_548_674n, true);
  view.setBigUint64(80, 1_790_000_000n, true);
  buf[88] = 0; // Pending
  buf[89] = 254;
  const v = decodeEscrowVault(buf);
  assert.deepEqual(v.payer, new Uint8Array(32).fill(1));
  assert.deepEqual(v.beneficiary, new Uint8Array(32).fill(2));
  assert.equal(v.amount, 22_548_674n);
  assert.equal(v.deadline, 1_790_000_000n);
  assert.equal(v.status, 0);
  assert.equal(v.bump, 254);

  buf[0] = buf[0]! ^ 0xff;
  assert.throws(() => decodeEscrowVault(buf), /not an EscrowVault/);
});

test("client getEscrow() and refundEscrow() go through the chain backend", async () => {
  const escrow: SolanaEscrowState = { payer: "Payer111", amount: 5n, deadline: 9n, status: 0 };
  const seen: string[] = [];
  const chain: SolanaChain = {
    async submitIntent() {
      throw new Error("unused");
    },
    async readIntent() {
      return null;
    },
    async readEscrow(id) {
      seen.push(`read:${id}`);
      return escrow;
    },
    async refundEscrow(id) {
      seen.push(`refund:${id}`);
      return { signature: "sig123" };
    },
  };
  const client = new BosphorSolanaClient({ chain, relayerUrl: "https://r", dstEid: 1 });
  assert.deepEqual(await client.getEscrow(INTENT_ID), escrow);
  assert.deepEqual(await client.refundEscrow(INTENT_ID), { txHash: "sig123" });
  assert.deepEqual(seen, [`read:${INTENT_ID}`, `refund:${INTENT_ID}`]);
});

test("refundEscrow() fails loudly when the backend has no refund support", async () => {
  const chain: SolanaChain = {
    async submitIntent() {
      throw new Error("unused");
    },
    async readIntent() {
      return null;
    },
  };
  const client = new BosphorSolanaClient({ chain, relayerUrl: "https://r", dstEid: 1 });
  await assert.rejects(client.refundEscrow(INTENT_ID), /does not implement refundEscrow/);
  await assert.rejects(client.getEscrow(INTENT_ID), /does not implement readEscrow/);
});
