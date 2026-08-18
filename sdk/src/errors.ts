/**
 * Typed error hierarchy for the Bosphor SDK.
 *
 * Every error the SDK throws on a well-defined failure extends {@link BosphorError},
 * so a consumer can `catch (e) { if (e instanceof BosphorError) ... }` once and then
 * narrow on the concrete subclass. The SDK never fabricates a result on failure: it
 * throws one of these with the on-chain / relayer reason attached.
 */

import type { Hex } from "./types.js";

/** Base class for every error the Bosphor SDK throws. */
export class BosphorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore the prototype chain across the TS/ES class-extends-Error boundary,
    // so `instanceof` works when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `awaitProof`/`store` when an intent has not executed within the proof
 * timeout. `intentId` is the intent that timed out; `timeoutMs` is the budget that
 * elapsed. The intent may still execute later; re-poll with `awaitProof(intentId)`.
 */
export class ProofTimeoutError extends BosphorError {
  readonly intentId: Hex;
  readonly timeoutMs: number;
  constructor(intentId: Hex, timeoutMs: number) {
    super(`intent ${intentId} did not execute within ${timeoutMs}ms`);
    this.intentId = intentId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by `upload`/`store` when the relayer rejects the out-of-band blob upload
 * with a non-2xx response. `status` is the HTTP status and the message carries the
 * relayer's own reason (e.g. "no pending intent", "blob id mismatch"), so the
 * failure is actionable without a second lookup.
 */
export class RelayerUploadError extends BosphorError {
  readonly status: number;
  readonly intentId: Hex;
  readonly reason: string;
  constructor(intentId: Hex, status: number, reason: string) {
    super(`relayer rejected blob for intent ${intentId} (HTTP ${status}): ${reason}`);
    this.status = status;
    this.intentId = intentId;
    this.reason = reason;
  }
}
