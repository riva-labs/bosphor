/**
 * Unit tests for the Sui -> Solana return worker's forward event cursor (bosphor#442).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LzPacket } from "./lz-packet.ts";
import {
  anchorFromHistory,
  cursorAfterEmptyPage,
  cursorDecision,
  drainEvents,
  isCursorRejected,
  isRouteReturn,
  parseCursorState,
  toBytes32Hex,
  type CursorStep,
  type ReturnRoute,
  type StreamEvent,
} from "./return-cursor.ts";

const SUI_OAPP = "0x" + "ba".repeat(32);
const STORE = "0x" + "5a".repeat(32);
const EVM_ADAPTER = "0x" + "00".repeat(12) + "3c".repeat(20);
const ROUTE: ReturnRoute = {
  srcEid: 40378,
  dstEid: 40168,
  senderB32: toBytes32Hex(SUI_OAPP),
  receiverB32: toBytes32Hex(STORE),
};

function pkt(nonce: bigint, over: Partial<LzPacket> = {}): LzPacket {
  return {
    version: 1,
    nonce,
    srcEid: 40378,
    sender: SUI_OAPP,
    dstEid: 40168,
    receiver: STORE,
    guid: "0x" + nonce.toString(16).padStart(64, "0"),
    message: "0x",
    header: "0x",
    payloadHash: "0x",
    ...over,
  };
}

/** A Solana-bound return at `nonce`, with cursor `c<i>`. */
const sol = (i: number, nonce: bigint): StreamEvent => ({ cursor: `c${i}`, packet: pkt(nonce) });
/** An EVM-bound return from the same Sui sender (Sepolia EID, EVM receiver). */
const evm = (i: number, nonce: bigint): StreamEvent => ({
  cursor: `c${i}`,
  packet: pkt(nonce, { dstEid: 40161, receiver: EVM_ADAPTER }),
});

/** A step that records what it was asked and blocks on the given nonces. */
function recorder(blockOn: bigint[] = []) {
  const asked: bigint[] = [];
  const step = async (p: LzPacket): Promise<CursorStep> => {
    asked.push(p.nonce);
    return blockOn.includes(p.nonce) ? "block" : "pass";
  };
  return { asked, step };
}

test("isRouteReturn: only packets to the Solana EID and our Store PDA are ours", () => {
  assert.equal(isRouteReturn(pkt(1n), ROUTE), true);
  // EVM return from the same Sui sender: different destination EID and receiver.
  assert.equal(isRouteReturn(pkt(1n, { dstEid: 40161, receiver: EVM_ADAPTER }), ROUTE), false);
  // Right EID but another receiver, or another sender: not ours either.
  assert.equal(isRouteReturn(pkt(1n, { receiver: EVM_ADAPTER }), ROUTE), false);
  assert.equal(isRouteReturn(pkt(1n, { sender: EVM_ADAPTER }), ROUTE), false);
  assert.equal(isRouteReturn(pkt(1n, { srcEid: 40161 }), ROUTE), false);
});

test("isRouteReturn: sender and receiver match regardless of case and left padding", () => {
  const route = { ...ROUTE, senderB32: toBytes32Hex("0x0ABC"), receiverB32: toBytes32Hex(STORE) };
  assert.equal(isRouteReturn(pkt(1n, { sender: "0x" + "0".repeat(60) + "0abc" }), route), true);
  assert.equal(isRouteReturn(pkt(1n, { receiver: STORE.toUpperCase().replace("0X", "0x") }), ROUTE), true);
});

test("drainEvents: EVM-bound packets never reach delivery, however many there are", async () => {
  // bosphor#442: 3000 EVM returns between two Solana returns used to push the
  // Solana one out of the newest-15 window and the 40x50 heal backfill.
  const events: StreamEvent[] = [sol(0, 471n)];
  for (let i = 1; i <= 3000; i++) events.push(evm(i, BigInt(5000 + i)));
  events.push(sol(3001, 472n));
  const { asked, step } = recorder();
  const r = await drainEvents(events, ROUTE, 0n, step);
  assert.deepEqual(asked, [471n, 472n]);
  assert.equal(r.passed, events.length);
  assert.equal(r.cursor, "c3001");
  assert.equal(r.blocked, null);
});

test("drainEvents: Solana returns are delivered in stream order", async () => {
  const { asked, step } = recorder();
  await drainEvents([sol(0, 10n), evm(1, 900n), sol(2, 11n), sol(3, 12n)], ROUTE, 0n, step);
  assert.deepEqual(asked, [10n, 11n, 12n]);
});

test("drainEvents: the cursor never moves past an undelivered return", async () => {
  const { asked, step } = recorder([11n]);
  const r = await drainEvents([sol(0, 10n), evm(1, 900n), sol(2, 11n), evm(3, 901n), sol(4, 12n)], ROUTE, 0n, step);
  // Stops at nonce 11: the cursor sits on the EVM event just before it, and
  // nonce 12 is not attempted (LZ inbound order is gapless).
  assert.deepEqual(asked, [10n, 11n]);
  assert.equal(r.cursor, "c1");
  assert.equal(r.passed, 2);
  assert.equal(r.blocked?.nonce, 11n);
});

test("drainEvents: a block on the first event leaves the cursor where it was", async () => {
  const { step } = recorder([10n]);
  const r = await drainEvents([sol(0, 10n), sol(1, 11n)], ROUTE, 0n, step);
  assert.equal(r.passed, 0);
  assert.equal(r.cursor, null);
  assert.equal(r.blocked?.nonce, 10n);
});

test("drainEvents: resuming from the blocked return retries it, then carries on in order", async () => {
  const events = [sol(0, 10n), evm(1, 900n), sol(2, 11n), sol(3, 12n)];
  const first = await drainEvents(events, ROUTE, 0n, recorder([11n]).step);
  const rest = events.slice(first.passed);
  const { asked, step } = recorder();
  const second = await drainEvents(rest, ROUTE, 0n, step);
  assert.deepEqual(asked, [11n, 12n]);
  assert.equal(second.cursor, "c3");
});

test("drainEvents: returns under RETURN_MIN_NONCE and undecodable events are passed without delivery", async () => {
  const { asked, step } = recorder();
  const r = await drainEvents([sol(0, 1n), { cursor: "c1", packet: null }, sol(2, 2n)], ROUTE, 2n, step);
  assert.deepEqual(asked, [2n]);
  assert.equal(r.cursor, "c2");
});

test("drainEvents: an empty page moves nothing", async () => {
  const r = await drainEvents([], ROUTE, 0n, recorder().step);
  assert.deepEqual(r, { passed: 0, cursor: null, blocked: null });
});

test("cursorDecision: only a delivery moves the cursor", () => {
  assert.equal(cursorDecision("sent", false, 0, 5), "pass");
  assert.equal(cursorDecision("already", false, 0, 5), "pass");
  assert.equal(cursorDecision("skipped", false, 99, 5), "block");
  // DRY-RUN sends nothing, so it never moves the cursor.
  assert.equal(cursorDecision("dry", true, 99, 5), "block");
});

test("cursorDecision: a committed nonce whose lz_receive keeps failing moves to the sweep", () => {
  assert.equal(cursorDecision("skipped", true, 4, 5), "block");
  assert.equal(cursorDecision("skipped", true, 5, 5), "handoff");
  // Not verified + committed on chain: handing it off would open a gap. Block.
  assert.equal(cursorDecision("skipped", false, 5, 5), "block");
});

test("anchorFromHistory: anchors on the newest return at or below the frontier", () => {
  // Newest first, as the backward history read returns it.
  const history = [sol(5, 13n), evm(4, 902n), sol(3, 12n), evm(2, 901n), sol(1, 11n), sol(0, 10n)];
  const r = anchorFromHistory(history, ROUTE, 11n);
  assert.equal(r.anchor, "c1");
  // Everything newer than the anchor is drained first, oldest first.
  assert.deepEqual(
    r.pending.map((e) => e.cursor),
    ["c2", "c3", "c4", "c5"],
  );
});

test("anchorFromHistory: EVM returns with a low nonce never anchor the Solana cursor", () => {
  const history = [sol(2, 50n), evm(1, 3n), sol(0, 40n)];
  const r = anchorFromHistory(history, ROUTE, 45n);
  assert.equal(r.anchor, "c0");
  assert.deepEqual(r.pending.map((e) => e.cursor), ["c1", "c2"]);
});

test("anchorFromHistory: frontier caught up with the tip leaves nothing pending", () => {
  const r = anchorFromHistory([sol(1, 11n), sol(0, 10n)], ROUTE, 11n);
  assert.equal(r.anchor, "c1");
  assert.deepEqual(r.pending, []);
});

test("anchorFromHistory: no return at or below the frontier in the history read drains all of it", () => {
  const r = anchorFromHistory([sol(2, 30n), evm(1, 900n), sol(0, 29n)], ROUTE, 5n);
  assert.equal(r.anchor, null);
  assert.deepEqual(r.pending.map((e) => e.cursor), ["c0", "c1", "c2"]);
  assert.deepEqual(anchorFromHistory([], ROUTE, 5n), { anchor: null, pending: [] });
});

test("cursorAfterEmptyPage: steps over an empty filtered page only while more history remains", () => {
  assert.equal(cursorAfterEmptyPage("c1", { hasNextPage: true, endCursor: "c9" }), "c9");
  assert.equal(cursorAfterEmptyPage("c1", { hasNextPage: false, endCursor: "c9" }), "c1");
  assert.equal(cursorAfterEmptyPage("c1", { hasNextPage: true, endCursor: null }), "c1");
});

test("parseCursorState: resumes from a saved cursor, ignores a missing or malformed one", () => {
  assert.equal(parseCursorState({ eventCursor: "AAEB", lastNonce: "12" }), "AAEB");
  assert.equal(parseCursorState(undefined), null);
  assert.equal(parseCursorState(null), null);
  assert.equal(parseCursorState({ eventCursor: "" }), null);
  assert.equal(parseCursorState({ eventCursor: 42 }), null);
  assert.equal(parseCursorState("AAEB"), null);
});

test("isCursorRejected: a GraphQL cursor parse error re-anchors, a network error retries", () => {
  assert.equal(
    isCursorRejected(new Error('sui graphql error: [{"message":"Failed to parse \\"String\\": Invalid Base64"}]')),
    true,
  );
  assert.equal(isCursorRejected(new Error("sui graphql 503 (0 bytes)")), false);
  assert.equal(isCursorRejected(new Error("fetch failed")), false);
});
