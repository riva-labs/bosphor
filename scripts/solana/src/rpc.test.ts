import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import { RateLimitStreak, pollDelay, sendPolled } from "./rpc.ts";

test("pollDelay keeps the normal poll interval while the RPC is healthy", () => {
  assert.equal(pollDelay(15_000, 0), 15_000);
});

test("pollDelay backs off exponentially with jitter after rate-limited ticks, capped", () => {
  // Equal jitter: half the backoff is fixed, the other half is random.
  assert.equal(pollDelay(15_000, 1, () => 0), 15_000); // 30s backoff, low end
  assert.equal(pollDelay(15_000, 1, () => 1), 30_000); // 30s backoff, high end
  assert.equal(pollDelay(15_000, 2, () => 1), 60_000);
  // Long 429 streaks stop growing at the cap (5 min).
  assert.equal(pollDelay(15_000, 20, () => 1), 300_000);
  assert.equal(pollDelay(15_000, 20, () => 0), 150_000);
});

test("sendPolled confirms through a rate-limited status poll without an unhandled rejection", async () => {
  // web3.js sendAndConfirmTransaction polls getSignatureStatus from an un-awaited
  // promise, so a 429 there became an unhandled rejection that exited the
  // Solana return worker (#486). sendPolled must surface or absorb it instead.
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const payer = Keypair.generate();
    let statusCalls = 0;
    const conn = {
      getLatestBlockhash: async () => ({
        blockhash: Keypair.generate().publicKey.toBase58(),
        lastValidBlockHeight: 1_000,
      }),
      sendRawTransaction: async () => "sig1",
      getSignatureStatuses: async () => {
        if (++statusCalls === 1) throw new Error("429 Too Many Requests");
        return { value: [{ confirmationStatus: "confirmed", err: null }] };
      },
      getBlockHeight: async () => 10,
    };
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
    );

    const sig = await sendPolled(conn as never, tx, payer, { pollMs: 1 });

    assert.equal(sig, "sig1");
    assert.equal(statusCalls, 2);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("sendPolled re-checks the status before declaring a tx expired, so a late landing is not resent", async () => {
  const payer = Keypair.generate();
  let statusCalls = 0;
  const conn = {
    getLatestBlockhash: async () => ({
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    }),
    sendRawTransaction: async () => "sig2",
    // First poll: not seen yet. It lands in the last valid block, which the
    // height read below already shows as passed.
    getSignatureStatuses: async () => ({
      value: [++statusCalls === 1 ? null : { confirmationStatus: "confirmed", err: null }],
    }),
    getBlockHeight: async () => 101,
  };
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: payer.publicKey, lamports: 1 }),
  );

  assert.equal(await sendPolled(conn as never, tx, payer, { pollMs: 1 }), "sig2");
});

test("RateLimitStreak counts consecutive ticks that hit a 429 anywhere, and resets on a clean tick", () => {
  const rl = new RateLimitStreak();
  // A 429 caught and swallowed deep inside a delivery still marks the tick.
  rl.note(new Error("429 Too Many Requests"));
  rl.note(new Error("custom program error: 0x1771"));
  assert.equal(rl.endTick(), 1);
  rl.note(new Error("Server responded with 429"));
  assert.equal(rl.endTick(), 2);
  // Non-rate-limit errors alone do not back off.
  rl.note(new Error("fetch failed"));
  assert.equal(rl.endTick(), 0);
});
