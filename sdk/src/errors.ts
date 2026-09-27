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

/**
 * Construction options shared by every {@link BosphorError}.
 *
 * @inline
 */
export interface BosphorErrorOptions {
  /** Stable machine-readable code. Part of the SemVer-protected API. */
  code?: string;
  /** Whether retrying the same operation could plausibly succeed. */
  retryable?: boolean;
  /** The underlying error, preserved on the standard `cause` chain. */
  cause?: unknown;
  /** How long the server asked the caller to wait before retrying, in milliseconds. */
  retryAfterMs?: number | undefined;
}

/** Base class for every error the Bosphor SDK throws. */
export class BosphorError extends Error {
  /** Stable, machine-readable error code (does not change when the message does). */
  readonly code: string;
  /** True when retrying the same operation could plausibly succeed. */
  readonly retryable: boolean;
  /**
   * How long to wait before retrying, in milliseconds, when the relayer said so
   * with a `Retry-After` header (on a 429 or 503). `undefined` when it did not.
   */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: BosphorErrorOptions = {}) {
    // Only pass ErrorOptions when there is a cause, so exactOptionalPropertyTypes
    // does not object to an explicit `undefined`.
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.code = options.code ?? "BOSPHOR_ERROR";
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
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
  /** The intent that did not execute in time. */
  readonly intentId: Hex;
  /** The timeout that elapsed, in milliseconds. */
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
 * retryable, as is a 429 (rate limited, see `retryAfterMs`); a terminal 4xx
 * (already executed, expired, bad blob) is not. `upload`/`store` already retry
 * the retryable ones with bounded backoff before throwing this.
 *
 * @property code `"RELAYER_UPLOAD_FAILED"`
 */
export class RelayerUploadError extends BosphorError {
  /** The HTTP status the relayer answered with. */
  readonly status: number;
  /** The intent whose bytes were rejected. */
  readonly intentId: Hex;
  /** The relayer's own error message, for example `"no pending intent"`. */
  readonly reason: string;
  constructor(intentId: Hex, status: number, reason: string, retryAfterMs?: number) {
    super(`relayer rejected blob for intent ${intentId} (HTTP ${status}): ${reason}`, {
      code: "RELAYER_UPLOAD_FAILED",
      retryable: status === 404 || isRetryableStatus(status),
      retryAfterMs,
    });
    this.status = status;
    this.intentId = intentId;
    this.reason = reason;
  }
}

/**
 * Whether an HTTP status from the relayer is transient: 408 (timeout), 429 (rate
 * limited) and any 5xx. Other 4xx statuses are terminal for the same request.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Thrown when a relayer HTTP call (quote, blob encode, LayerZero fee) answers
 * with a non-2xx status. `status` is the HTTP status, `body` the relayer's raw
 * response text, and `retryAfterMs` the parsed `Retry-After` header (sent with a
 * 429 or 503), so a caller can back off exactly as long as the relayer asked.
 *
 * `retryable` is true for 408, 429 and 5xx, false for any other 4xx.
 *
 * @property code `"RELAYER_REQUEST_FAILED"`
 */
export class RelayerRequestError extends BosphorError {
  /** The relayer operation that failed, for example `"quote"` or `"blob encode"`. */
  readonly operation: string;
  /** The HTTP status the relayer answered with. */
  readonly status: number;
  /** The relayer's raw response body (usually JSON with a `message`). */
  readonly body: string;
  constructor(operation: string, status: number, body: string, retryAfterMs?: number) {
    super(`relayer ${operation} failed (${status}): ${body}`, {
      code: "RELAYER_REQUEST_FAILED",
      retryable: isRetryableStatus(status),
      retryAfterMs,
    });
    this.operation = operation;
    this.status = status;
    this.body = body;
  }
}
