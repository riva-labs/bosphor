/**
 * Unit tests for the Sui -> Solana return worker's nonce self-heal (bosphor#525).
 * Mirrors the EVM return worker's tests in bosphor-dvn (src/return-loop.test.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  healRange,
  isCommittedHash,
  sweepRange,
  initialSweptThrough,
  nextStranded,
  settleSweepBatch,
  sweepExecuted,
  healResult,
  positiveInt,
} from "./return-heal.ts";

test("healRange: no gap when the visible tip is at most one past the frontier", () => {
  assert.equal(healRange(100n, 100n, 10n, null), null);
  assert.equal(healRange(100n, 101n, 10n, null), null);
});

test("healRange: a frontier stuck under the tip heals from frontier+1, at most max nonces per tick", () => {
  // Live 2026-09: a 471->1064 backlog was cleared by hand; a bounded batch keeps
  // one tick from monopolising the rate-limited devnet RPC.
  assert.deepEqual(healRange(471n, 480n, 10n, null), { from: 472n, to: 480n });
  assert.deepEqual(healRange(471n, 1064n, 10n, null), { from: 472n, to: 481n });
});

test("healRange: a frontier already found unrecoverable is not re-paginated until it moves", () => {
  assert.equal(healRange(471n, 1064n, 10n, 471n), null);
  // Once the frontier advances (manual skip or a new delivery) healing resumes.
  assert.deepEqual(healRange(472n, 1064n, 10n, 471n), { from: 473n, to: 482n });
});

test("isCommittedHash: a real payload hash is committed", () => {
  assert.equal(isCommittedHash(new Array(32).fill(0xab)), true);
  const mixed = new Array(32).fill(0);
  mixed[31] = 1;
  assert.equal(isCommittedHash(mixed), true);
});

test("isCommittedHash: a zeroed (initVerify only) or nilified hash is not waiting for lz_receive", () => {
  assert.equal(isCommittedHash(new Array(32).fill(0)), false);
  assert.equal(isCommittedHash(new Array(32).fill(0xff)), false);
  assert.equal(isCommittedHash([]), false);
});

test("sweepRange: scans the next nonces under the inbound frontier, at most one batch per sweep", () => {
  assert.deepEqual(sweepRange(100n, 120n, 50n), { from: 101n, to: 120n });
  assert.deepEqual(sweepRange(100n, 500n, 50n), { from: 101n, to: 150n });
});

test("sweepRange: nothing to scan once the sweep has caught up with the frontier", () => {
  assert.equal(sweepRange(120n, 120n, 50n), null);
  assert.equal(sweepRange(130n, 120n, 50n), null);
});

test("initialSweptThrough: a boot looks back a bounded window under the frontier", () => {
  assert.equal(initialSweptThrough(4616n, 1000n), 3616n);
  assert.equal(initialSweptThrough(150n, 1000n), 0n);
});

test("initialSweptThrough: RETURN_SWEEP_FROM rewinds to reach an old backlog but never skips ahead", () => {
  assert.equal(initialSweptThrough(4616n, 1000n, 470n), 470n);
  assert.equal(initialSweptThrough(4616n, 1000n, 4000n), 3616n);
});

test("nextStranded: a scanned nonce with a committed hash under the frontier is stranded", () => {
  const scanned = [
    { nonce: 101n, committed: false },
    { nonce: 102n, committed: true },
    { nonce: 103n, committed: false },
  ];
  assert.deepEqual(nextStranded([], scanned), [102n]);
});

test("nextStranded: keeps the queue order and does not duplicate a re-scanned nonce", () => {
  assert.deepEqual(nextStranded([120n], [{ nonce: 90n, committed: true }]), [120n, 90n]);
  assert.deepEqual(nextStranded([90n], [{ nonce: 90n, committed: true }]), [90n]);
});

test("settleSweepBatch: an executed nonce leaves the queue and its attempt count is cleared", () => {
  const r = settleSweepBatch([10n, 11n, 12n], new Map([[10n, true]]), { "10": 2 }, 5);
  assert.deepEqual(r.queue, [11n, 12n]);
  assert.deepEqual(r.attempts, {});
  assert.deepEqual(r.abandoned, []);
});

test("settleSweepBatch: a failed nonce moves to the back so it cannot block younger stranded nonces", () => {
  const r = settleSweepBatch([10n, 11n, 12n], new Map([[10n, false]]), {}, 5);
  assert.deepEqual(r.queue, [11n, 12n, 10n]);
  assert.deepEqual(r.attempts, { "10": 1 });
  assert.deepEqual(r.abandoned, []);
});

test("settleSweepBatch: a nonce that fails maxAttempts sweeps is abandoned, not retried forever", () => {
  const r = settleSweepBatch([10n, 11n], new Map([[10n, false]]), { "10": 4 }, 5);
  assert.deepEqual(r.queue, [11n]);
  assert.deepEqual(r.attempts, {});
  assert.deepEqual(r.abandoned, [10n]);
});

test("sweepExecuted: a confirmed lz_receive tx is proof even when the chain re-read is stale", () => {
  assert.equal(sweepExecuted("sent", false), true);
});

test("sweepExecuted: an ambiguous outcome is settled only by chain state", () => {
  assert.equal(sweepExecuted("already", false), false);
  assert.equal(sweepExecuted("already", true), true);
  assert.equal(sweepExecuted("skipped", false), false);
  assert.equal(sweepExecuted("skipped", true), true);
});

test("healResult: maps deliver outcomes onto the shared self-heal metric labels", () => {
  assert.equal(healResult("sent"), "delivered");
  assert.equal(healResult("already"), "already");
  assert.equal(healResult("skipped"), "failed");
  assert.equal(healResult("dry"), "dry");
});

test("positiveInt: unset falls back to the default, a positive integer is used as is", () => {
  assert.equal(positiveInt("X", undefined, 50), 50);
  assert.equal(positiveInt("X", "7", 50), 7);
});

test("positiveInt: an empty, zero, negative or non-numeric value fails loudly at boot", () => {
  for (const raw of ["", "0", "-3", "abc", "1.5"]) {
    assert.throws(() => positiveInt("RETURN_SWEEP_BATCH", raw, 50), /RETURN_SWEEP_BATCH/, `raw=${raw}`);
  }
});
