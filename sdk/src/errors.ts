/**
 * Typed error hierarchy for the Bosphor SDK.
 *
 * Every error the SDK throws on a well-defined failure extends {@link BosphorError},
 * so a consumer can `catch (e) { if (e instanceof BosphorError) ... }` once and then
 * narrow on the concrete subclass. The SDK never fabricates a result on failure: it
 * throws one of these with the on-chain / relayer reason attached.
 *
 * Two fields are part of the stable API, not the message: `code` is a fixed string
 * for programmatic handling and i18n (the human message may change; the code will
 * not), and `retryable` says whether retrying the same call could succeed.
 */

import type { Hex } from "./types.js";

/** Construction options shared by every {@link BosphorError}. */
export interface BosphorErrorOptions {
  /** Stable machine-readable code. Part of the SemVer-protected API. */
  code?: string;
  /** Whether retrying the same operation could plausibly succeed. */
  retryable?: boolean;
  /** The underlying error, preserved on the standard `cause` chain. */
  cause?: unknown;
}

/** Base class for every error the Bosphor SDK throws. */
export class BosphorError extends Error {
  /** Stable, machine-readable error code (does not change when the message does). */
  readonly code: string;
  /** True when retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;

  constructor(message: string, options: BosphorErrorOptions = {}) {
    // Only pass ErrorOptions when there is a cause, so exactOptionalPropertyTypes
    // does not object to an explicit `undefined`.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "BOSPHOR_ERROR";
    this.retryable = options.retryable ?? false;
    // Restore the prototype chain across the TS/ES class-extends-Error boundary,
    // so `instanceof` works when compiled to older targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by `awaitProof`/`store` when an intent has not executed within the proof
 * timeout. `intentId` is the intent that timed out; `timeoutMs` is the budget that
 * elapsed. The intent may still execute later, so this is `retryable`: re-poll with
 * `awaitProof(intentId)`.
 *
 * @property code `"PROOF_TIMEOUT"`
 */
export class ProofTimeoutError extends BosphorError {
  readonly intentId: Hex;
  readonly timeoutMs: number;
  constructor(intentId: Hex, timeoutMs: number) {
    super(`intent ${intentId} did not execute within ${timeoutMs}ms`, {
      code: "PROOF_TIMEOUT",
      retryable: true,
    });
    this.intentId = intentId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by `upload`/`store` when the relayer rejects the out-of-band blob upload
 * with a non-2xx response. `status` is the HTTP status and `reason` carries the
 * relayer's own message (e.g. "no pending intent", "blob id mismatch"), so the
 * failure is actionable without a second lookup.
 *
 * `retryable` is derived from the status: a 404 means the relayer has not seen the
 * on-chain intent yet (retry past the watch lag) and a 5xx is transient, so both are
 * retryable; a terminal 4xx (already executed, expired, bad blob) is not.
 *
 * @property code `"RELAYER_UPLOAD_FAILED"`
 */
export class RelayerUploadError extends BosphorError {
  readonly status: number;
  readonly intentId: Hex;
  readonly reason: string;
  constructor(intentId: Hex, status: number, reason: string) {
    super(`relayer rejected blob for intent ${intentId} (HTTP ${status}): ${reason}`, {
      code: "RELAYER_UPLOAD_FAILED",
      retryable: status === 404 || status >= 500,
    });
    this.status = status;
    this.intentId = intentId;
    this.reason = reason;
  }
}

/**
 * Thrown by `decodeCommitment` when the version byte of an encoded commitment is
 * not one the SDK understands. A mismatch means the counterpart (contract or
 * relayer) speaks a different wire-format generation; retrying cannot help.
 *
 * @property code `"UNSUPPORTED_COMMITMENT_VERSION"`
 */
export class UnsupportedCommitmentVersionError extends BosphorError {
  /** The version byte found in the encoded commitment. */
  readonly version: number;
  /** The single version this SDK build supports. */
  readonly supported: number;
  constructor(version: number, supported: number) {
    super(`unsupported commitment version ${version}, this SDK supports version ${supported}`, {
      code: "UNSUPPORTED_COMMITMENT_VERSION",
      retryable: false,
    });
    this.version = version;
    this.supported = supported;
  }
}
