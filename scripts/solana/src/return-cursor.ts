/**
 * Forward cursor over the Sui PacketSentEvent stream for the Sui -> Solana
 * return worker (bosphor#442). Pure logic, factored out of solana-return.ts so
 * it can be unit-tested without a keypair, an RPC, or the env config that
 * module loads at import time.
 *
 * Why: the worker used to read only the newest 15 events (plus a bounded heal
 * backfill). The Sui relayer that sends Solana returns also sends every EVM
 * return, so under EVM-heavy traffic a Solana return scrolled out of both
 * windows and the gapless inbound order wedged the channel until a manual
 * skip-return-nonce. Now the worker pages FORWARD from a persisted cursor and
 * sees every event exactly once:
 *   - events for any other pathway (EVM returns) are stepped over: they never
 *     need anything from this worker, so they cost a page read, not a nonce;
 *   - every Solana-bound return is delivered in stream order;
 *   - the cursor never moves past a Solana return that is not delivered, the
 *     exact bug that wedged the forward DVN path before (bosphor-dvn#2, #4).
 */
import type { LzPacket } from "./lz-packet.ts";
import type { DeliverResult } from "./return-heal.ts";

/** The pathway a return packet must match to be ours (all bytes32 lowercase hex, no 0x). */
export interface ReturnRoute {
  srcEid: number;
  dstEid: number;
  senderB32: string;
  receiverB32: string;
}

/** Left-pad a 0x hex value to a 32-byte (64 hex char) lowercase bytes32, no 0x. */
export function toBytes32Hex(hex: string): string {
  const h = (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
  if (h.length > 64) throw new Error(`value exceeds 32 bytes: ${hex}`);
  return h.padStart(64, "0");
}

/**
 * Is this packet a return on our pathway (Sui OApp -> our Store PDA on
 * Solana)? Matching the destination EID AND the receiver is what keeps EVM
 * returns from the same Sui sender out of this worker's work.
 */
export function isRouteReturn(pkt: LzPacket, route: ReturnRoute): boolean {
  return (
    pkt.srcEid === route.srcEid &&
    pkt.dstEid === route.dstEid &&
    toBytes32Hex(pkt.sender) === route.senderB32 &&
    toBytes32Hex(pkt.receiver) === route.receiverB32
  );
}

/** One PacketSentEvent with its stream position. `packet` is null when undecodable. */
export interface StreamEvent {
  cursor: string;
  packet: LzPacket | null;
}

/** Whether the cursor may move past a return packet, decided by the caller per packet. */
export type CursorStep = "pass" | "block";

export interface DrainResult {
  /** How many leading events the cursor moved past. */
  passed: number;
  /** Cursor of the last event moved past; null when none was. */
  cursor: string | null;
  /** The return packet that stopped the drain (not delivered), if any. */
  blocked: LzPacket | null;
}

/**
 * Walk `events` (oldest first) and move the cursor as far as is safe:
 *   - an event that is not ours (other pathway, undecodable) is passed;
 *   - our return under `minNonce` is passed without delivery (RETURN_MIN_NONCE);
 *   - our return is handed to `step` and passed only when it answers "pass".
 * Stops at the first "block": nothing after an undelivered return is touched,
 * so the next drain starts again at that packet.
 */
export async function drainEvents(
  events: StreamEvent[],
  route: ReturnRoute,
  minNonce: bigint,
  step: (pkt: LzPacket) => Promise<CursorStep>,
): Promise<DrainResult> {
  let cursor: string | null = null;
  let passed = 0;
  for (const ev of events) {
    const pkt = ev.packet;
    if (pkt && isRouteReturn(pkt, route) && pkt.nonce >= minNonce) {
      if ((await step(pkt)) !== "pass") return { passed, cursor, blocked: pkt };
    }
    cursor = ev.cursor;
    passed++;
  }
  return { passed, cursor, blocked: null };
}

/**
 * Whether the cursor may move past a return packet after one delivery attempt.
 *   sent, already          delivered: pass.
 *   dry                    nothing was sent (DRY-RUN): block, never pretend.
 *   skipped                not delivered: block, retry next tick. The one
 *                          exception is a nonce the endpoint shows verified +
 *                          committed (at or below the inbound frontier, so no
 *                          gap can form) whose lz_receive has now failed
 *                          `maxAttempts` times: it moves to the stranded sweep,
 *                          which retries and reports it, so one poison message
 *                          cannot wedge every later Solana return.
 */
export function cursorDecision(
  result: DeliverResult,
  committedOnChain: boolean,
  attempts: number,
  maxAttempts: number,
): CursorStep | "handoff" {
  if (result === "sent" || result === "already") return "pass";
  if (result === "skipped" && committedOnChain && attempts >= maxAttempts) return "handoff";
  return "block";
}

/**
 * Where to start the cursor when there is no saved one (first boot, or no
 * state volume), from the newest-first history read so far. The anchor is the
 * newest return of ours whose nonce is at or below the endpoint's inbound
 * frontier: it and everything before it are verified (anything left
 * unexecuted there is the stranded sweep's job), so the forward walk starts
 * right after it. `pending` is every event newer than the anchor, oldest first,
 * to be drained before paging forward. `anchor` is null when no such return is
 * in the history read; then `pending` is all of it.
 */
export function anchorFromHistory(
  newestFirst: StreamEvent[],
  route: ReturnRoute,
  frontier: bigint,
): { anchor: string | null; pending: StreamEvent[] } {
  const idx = newestFirst.findIndex(
    (ev) => ev.packet !== null && isRouteReturn(ev.packet, route) && ev.packet.nonce <= frontier,
  );
  if (idx === -1) return { anchor: null, pending: [...newestFirst].reverse() };
  return { anchor: newestFirst[idx].cursor, pending: newestFirst.slice(0, idx).reverse() };
}

/**
 * The cursor after a forward page that returned no events. A filtered query can
 * end its scan with an empty page while more history remains; stepping to the
 * page's endCursor keeps the walk moving. Otherwise the cursor stays put.
 */
export function cursorAfterEmptyPage(
  cursor: string | null,
  page: { hasNextPage: boolean; endCursor: string | null },
): string | null {
  return page.hasNextPage && page.endCursor ? page.endCursor : cursor;
}

/** Persisted form of the cursor (cursor-sui_solana.json). */
export interface ReturnCursorState {
  /** GraphQL cursor of the last PacketSentEvent the worker moved past. */
  eventCursor: string;
  /** Highest Solana return nonce moved past, for logs only. */
  lastNonce?: string;
  updatedAt?: string;
}

/** The saved event cursor, or null when the state is absent or malformed. */
export function parseCursorState(raw: unknown): string | null {
  const c = (raw as Partial<ReturnCursorState> | null | undefined)?.eventCursor;
  return typeof c === "string" && c.length > 0 ? c : null;
}

/**
 * Whether a Sui GraphQL error means the saved cursor itself was rejected
 * (malformed, or past the retained history), so the worker should drop it and
 * re-anchor, as opposed to a transient error that is retried as-is.
 */
export function isCursorRejected(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err);
  return /sui graphql error/i.test(msg) && /cursor|base64|failed to parse|out of range|pruned/i.test(msg);
}
