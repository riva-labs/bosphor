/**
 * HTTP-only Solana RPC helpers for the public devnet endpoint, which 429s hard
 * on bursts and even harder on the confirmation websocket. Nothing here opens a
 * websocket: confirmation polls getSignatureStatuses, and every call is wrapped
 * in a 429-aware exponential backoff.
 *
 * `withBackoff` and `isRateLimited` are pure (sleep is injectable) and tested.
 */

import type { Connection, Keypair, Transaction } from "@solana/web3.js";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** True for a rate-limit error from the RPC (HTTP 429 in any of its spellings). */
export function isRateLimited(err: unknown): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(String((err as Error)?.message ?? err));
}

export interface BackoffOptions {
  /** Retries after the first attempt (default 8). */
  retries?: number;
  /** First backoff delay in ms (default 1000); doubles each retry. */
  baseMs?: number;
  /** Backoff ceiling in ms (default 30000). */
  capMs?: number;
  /** Which errors to retry (default: rate limits only). */
  retryOn?: (err: unknown) => boolean;
  /** Injectable for tests. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Delay before retry `attempt` (0-based): base * 2^attempt, capped. */
export function backoffDelay(attempt: number, baseMs: number, capMs: number): number {
  return Math.min(baseMs * 2 ** attempt, capMs);
}

/** Run `fn`, retrying rate-limited failures with capped exponential backoff. */
export async function withBackoff<T>(fn: () => Promise<T>, o: BackoffOptions = {}): Promise<T> {
  const retries = o.retries ?? 8;
  const baseMs = o.baseMs ?? 1000;
  const capMs = o.capMs ?? 30_000;
  const retryOn = o.retryOn ?? isRateLimited;
  const wait = o.sleepFn ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !retryOn(err)) throw err;
      await wait(backoffDelay(attempt, baseMs, capMs));
    }
  }
}

/**
 * Sign, send, and confirm a transaction over HTTP only (no websocket). Preflight
 * stays ON so a failing transaction is rejected by simulation before it can
 * spend a fee. Polls getSignatureStatuses with backoff until `confirmed`.
 */
export async function sendPolled(
  conn: Connection,
  tx: Transaction,
  signer: Keypair,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const pollMs = opts.pollMs ?? 2_000;
  const { blockhash, lastValidBlockHeight } = await withBackoff(() =>
    conn.getLatestBlockhash("confirmed"),
  );
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = blockhash;
  tx.sign(signer);
  const sig = await withBackoff(() =>
    conn.sendRawTransaction(tx.serialize(), { preflightCommitment: "confirmed" }),
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    const st = (await withBackoff(() => conn.getSignatureStatuses([sig]))).value[0];
    if (st?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    const height = await withBackoff(() => conn.getBlockHeight("confirmed"));
    if (height > lastValidBlockHeight) throw new Error(`tx ${sig} expired (blockhash too old)`);
  }
  throw new Error(`tx ${sig} not confirmed within ${timeoutMs}ms`);
}

/**
 * Poll `probe` (with rate-limit backoff on every call) until it returns a
 * non-null value or the timeout passes. Returns null on timeout; never throws a
 * fabricated success.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | null>,
  opts: { timeoutMs: number; pollMs: number; onTick?: (elapsedMs: number) => void },
): Promise<T | null> {
  const started = Date.now();
  for (;;) {
    const v = await withBackoff(probe);
    if (v !== null) return v;
    const elapsed = Date.now() - started;
    if (elapsed >= opts.timeoutMs) return null;
    opts.onTick?.(elapsed);
    await sleep(opts.pollMs);
  }
}
