/**
 * Pure decision logic for the Sui -> Solana return worker's nonce self-heal
 * (bosphor#525), ported from the EVM return worker in bosphor-dvn
 * (src/return-loop.ts, PRs #3, #8, #9). Factored out of solana-return.ts so it
 * can be unit-tested without a keypair, an RPC, or the env config that module
 * loads at import time.
 *
 * Two failure classes, both observed on the EVM return leg first:
 *   gap       a return nonce above the endpoint's inbound frontier was never
 *             verified, so LayerZero's gapless order blocks every later nonce
 *             (InvalidNonce) and all escrow releases stall.
 *   stranded  a return nonce at or below the frontier was verified + committed
 *             but lz_receive never ran (it failed once and then scrolled out of
 *             the newest-window). Nothing blocks the channel, but that intent's
 *             escrow is never released (bosphor#495).
 */

/**
 * The gap nonces to heal this tick: frontier+1 up to the visible tip, at most
 * `max` of them. Null when there is no gap, or when the last heal already found
 * this frontier unrecoverable (its packet is past the queryable history) and
 * the frontier has not moved since, so re-paginating history would be wasted
 * RPC load.
 */
export function healRange(
  frontier: bigint,
  tip: bigint,
  max: bigint,
  blockedAt: bigint | null,
): { from: bigint; to: bigint } | null {
  if (tip <= frontier + 1n) return null;
  if (blockedAt === frontier) return null;
  const from = frontier + 1n;
  const end = frontier + max;
  return { from, to: end < tip ? end : tip };
}

/**
 * Whether a payload hash account holds a committed hash. The endpoint's
 * initVerify allocates it zeroed, and a nilified nonce holds all 0xff; neither
 * is waiting for lz_receive.
 */
export function isCommittedHash(hash: ArrayLike<number>): boolean {
  let zero = true;
  let nil = true;
  for (let i = 0; i < hash.length; i++) {
    if (hash[i] !== 0) zero = false;
    if (hash[i] !== 0xff) nil = false;
  }
  return hash.length > 0 && !zero && !nil;
}

/**
 * The next nonces the stranded sweep should scan: from just above what it has
 * already scanned up to the inbound frontier, at most `batch` per sweep. A
 * stranded nonce can only sit at or below the frontier (above it nothing is
 * executable yet). Null when the sweep has caught up.
 */
export function sweepRange(
  sweptThrough: bigint,
  inboundNonce: bigint,
  batch: bigint,
): { from: bigint; to: bigint } | null {
  const from = sweptThrough + 1n;
  if (from > inboundNonce) return null;
  const end = sweptThrough + batch;
  return { from, to: end < inboundNonce ? end : inboundNonce };
}

/**
 * Where the stranded sweep starts on boot: `lookback` nonces under the inbound
 * frontier, so nonces stranded shortly before a restart are still checked
 * without rescanning the whole return history. `from` (RETURN_SWEEP_FROM)
 * rewinds it to reach an old backlog; it never moves the start forward.
 */
export function initialSweptThrough(inboundNonce: bigint, lookback: bigint, from?: bigint): bigint {
  const base = inboundNonce > lookback ? inboundNonce - lookback : 0n;
  return from !== undefined && from < base ? from : base;
}

/**
 * The stranded queue after a scan: the previous queue in order, plus any newly
 * scanned nonce whose payload hash is committed (verified, not executed).
 */
export function nextStranded(prev: bigint[], scanned: { nonce: bigint; committed: boolean }[]): bigint[] {
  const out = [...prev];
  for (const s of scanned) {
    if (s.committed && !out.includes(s.nonce)) out.push(s.nonce);
  }
  return out;
}

/**
 * Apply one sweep batch's outcomes (`executed` per attempted nonce). An
 * executed nonce leaves the queue. A failed one goes to the back so a nonce
 * that always fails cannot block younger ones, and after `maxAttempts` failed
 * sweeps it is abandoned (reported, not retried forever).
 */
export function settleSweepBatch(
  queue: bigint[],
  executed: Map<bigint, boolean>,
  attempts: Record<string, number>,
  maxAttempts: number,
): { queue: bigint[]; attempts: Record<string, number>; abandoned: bigint[] } {
  const next = { ...attempts };
  const kept: bigint[] = [];
  const retry: bigint[] = [];
  const abandoned: bigint[] = [];
  for (const n of queue) {
    const ok = executed.get(n);
    if (ok === undefined) {
      kept.push(n);
    } else if (ok) {
      delete next[n.toString()];
    } else {
      const count = (next[n.toString()] ?? 0) + 1;
      if (count >= maxAttempts) {
        delete next[n.toString()];
        abandoned.push(n);
      } else {
        next[n.toString()] = count;
        retry.push(n);
      }
    }
  }
  return { queue: [...kept, ...retry], attempts: next, abandoned };
}

/** Outcome of one deliver() attempt in solana-return.ts. */
export type DeliverResult = "sent" | "already" | "skipped" | "dry";

/**
 * Whether a stranded nonce the sweep just attempted is executed. "sent" means
 * the lz_receive tx confirmed, which is proof by itself (an immediate re-read
 * on a load-balanced RPC can still be stale). Anything else is settled by
 * chain state.
 */
export function sweepExecuted(result: DeliverResult, deliveredOnChain: boolean): boolean {
  return result === "sent" || deliveredOnChain;
}

/** `result` label of bosphor_dvn_self_heal_total, shared with the EVM return worker. */
export type SelfHealResult = "delivered" | "already" | "failed" | "missing" | "abandoned" | "dry";

/** Metric label for one gap-heal delivery. "skipped" means still not executed. */
export function healResult(result: DeliverResult): SelfHealResult {
  switch (result) {
    case "sent":
      return "delivered";
    case "skipped":
      return "failed";
    default:
      return result;
  }
}

/** Parse a positive-integer env value; unset uses the default, anything else invalid throws. */
export function positiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}
