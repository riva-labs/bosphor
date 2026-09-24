import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ESCROW_PENDING,
  ESCROW_RELEASED,
  ESCROW_REFUNDED,
  ESCROW_VAULT_LEN,
  balanceDelta,
  decodeEscrowVault,
  encodeEscrowVault,
  encodeRefundEscrowData,
  expectedCloseCredit,
  refundAllowed,
} from "./escrow.ts";
import { backoffDelay, isRateLimited, withBackoff } from "./rpc.ts";

const vault = {
  payer: new Uint8Array(32).fill(1),
  beneficiary: new Uint8Array(32).fill(2),
  amount: 20_530_273n,
  deadline: 1_790_000_000n,
  status: ESCROW_PENDING,
  bump: 254,
};

test("EscrowVault round-trips through the on-chain layout (90 bytes)", () => {
  const raw = encodeEscrowVault(vault);
  assert.equal(raw.length, ESCROW_VAULT_LEN);
  assert.equal(ESCROW_VAULT_LEN, 90);
  assert.deepEqual(decodeEscrowVault(raw), vault);
  // Anchor discriminator = sha256("account:EscrowVault")[..8].
  assert.deepEqual(raw.slice(0, 8), sha256(new TextEncoder().encode("account:EscrowVault")).slice(0, 8));
});

test("decodeEscrowVault rejects other accounts and short data", () => {
  const raw = encodeEscrowVault(vault);
  raw[0] ^= 0xff;
  assert.throws(() => decodeEscrowVault(raw), /discriminator/);
  assert.throws(() => decodeEscrowVault(new Uint8Array(10)), /too short/);
});

test("refund_escrow instruction data is discriminator ++ intent id", () => {
  const id = new Uint8Array(32).fill(0xab);
  const data = encodeRefundEscrowData(id);
  assert.equal(data.length, 40);
  assert.deepEqual(data.slice(0, 8), sha256(new TextEncoder().encode("global:refund_escrow")).slice(0, 8));
  assert.deepEqual(data.slice(8), id);
  assert.throws(() => encodeRefundEscrowData(new Uint8Array(31)), /32 bytes/);
});

test("refundAllowed mirrors check_refund: Pending and strictly past the deadline", () => {
  assert.equal(refundAllowed(ESCROW_PENDING, 1001n, 1000n), true);
  assert.equal(refundAllowed(ESCROW_PENDING, 1000n, 1000n), false);
  assert.equal(refundAllowed(ESCROW_RELEASED, 2000n, 1000n), false);
  assert.equal(refundAllowed(ESCROW_REFUNDED, 2000n, 1000n), false);
});

test("balance accounting for a vault closed to an account", () => {
  const meta = { fee: 5000, preBalances: [1_000_000, 50], postBalances: [1_995_000, 50] };
  assert.equal(balanceDelta(meta, 0), 995_000n);
  assert.throws(() => balanceDelta(meta, 5), /no balance/);
  // Refunder == payer: gains the whole vault minus its own fee.
  assert.equal(expectedCloseCredit(1_000_000n, 5000, true), 995_000n);
  // Beneficiary credited by someone else's tx: the whole vault.
  assert.equal(expectedCloseCredit(1_000_000n, 5000, false), 1_000_000n);
});

test("isRateLimited recognises 429 spellings only", () => {
  assert.equal(isRateLimited(new Error("429 Too Many Requests")), true);
  assert.equal(isRateLimited(new Error("Server responded with 429")), true);
  assert.equal(isRateLimited(new Error("rate limit exceeded")), true);
  assert.equal(isRateLimited(new Error("custom program error: 0x1771")), false);
});

test("withBackoff retries rate limits with capped exponential delay, then gives up", async () => {
  const waits: number[] = [];
  let calls = 0;
  const v = await withBackoff(
    async () => {
      if (++calls < 4) throw new Error("429 Too Many Requests");
      return "ok";
    },
    { baseMs: 100, capMs: 250, sleepFn: async (ms) => void waits.push(ms) },
  );
  assert.equal(v, "ok");
  assert.deepEqual(waits, [100, 200, 250]);
  assert.equal(backoffDelay(10, 1000, 30_000), 30_000);

  let n = 0;
  await assert.rejects(
    withBackoff(async () => { n++; throw new Error("429"); }, { retries: 2, sleepFn: async () => {} }),
    /429/,
  );
  assert.equal(n, 3);
  // Non-rate-limit errors are not retried.
  let m = 0;
  await assert.rejects(withBackoff(async () => { m++; throw new Error("boom"); }, { sleepFn: async () => {} }));
  assert.equal(m, 1);
});
