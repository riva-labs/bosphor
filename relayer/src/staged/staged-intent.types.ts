/**
 * Types for the durable store queue (`staged_intent`).
 *
 * M3 hardening: the relayer's store pipeline was fully in-memory (bytes in a Map,
 * a sweep, an in-flight Set). This queue makes it durable - bytes live in
 * Postgres, one row per intent, processed by a single-writer loop. See the
 * StagedIntentStore for the data-access surface.
 *
 * All timestamps are epoch milliseconds (BIGINT), matching the intent_lifecycle
 * table's convention so the two tables read the same way.
 */

/**
 * Coarse row lifecycle. Readiness ("has bytes + received + deadline in future")
 * is NOT a stored state; it is computed each tick from the columns, so there is
 * no "who flips waiting->ready" trigger to keep in sync.
 *
 *   active  -> the row is still in play (may or may not be ready to store)
 *   done    -> stored on Walrus, recorded on Sui, proof returned; bytes freed
 *   dead    -> pre-store attempts exhausted or a terminal error; bytes freed
 *   expired -> deadline passed before it stored; bytes freed
 */
export type StagedState = 'active' | 'done' | 'dead' | 'expired';

/**
 * A staged row WITHOUT its bytes. The drain query returns this shape so the 2s
 * poll never drags 10MB BYTEA payloads out of TOAST; the bytes are fetched
 * lazily (fetchBytes) only for a row that is actually being stored.
 */
export interface StagedIntentRow {
  intentId: string;
  /** Committed blob id (0x hex) from the IntentReceived event; a store-time fallback. */
  committedBlobId?: string;
  /** Committed size in bytes; summed for backpressure. Set when bytes are ingested. */
  size?: number;
  /** Intent deadline (epoch ms); governs expiry. Set from the IntentReceived event. */
  deadline?: number;
  /** Origin endpoint id; routes the return leg (EVM vs Solana). */
  srcEid?: number;
  /** Whether the Sui IntentReceived event has been seen. */
  received: boolean;
  /** Whether bytes are present (bytes IS NOT NULL) without selecting the payload. */
  hasBytes: boolean;
  /** Recomputed Walrus blob id (base64url) from ingest. */
  blobId?: string;
  /** Set after a successful Walrus upload - retry/crash skips re-upload (no double WAL). */
  walrusObjectId?: string;
  walrusBlobId?: string;
  endEpoch?: number;
  /** Set after a successful execute_store - retry skips re-recording on Sui. */
  storeDigest?: string;
  /** Whether the return-leg proof has been confirmed. */
  returned: boolean;
  state: StagedState;
  attempts: number;
  /** Earliest epoch ms this row may be claimed again (backoff gate). */
  nextAttemptAt: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/** Accepted out-of-band bytes bound to a commitment, awaiting store. */
export interface StagedBytes {
  bytes: Buffer;
  /** Recomputed Walrus blob id (base64url) that matched the commitment. */
  blobId: string;
  /** Committed size in bytes. */
  size: number;
}

/** Fields carried by the Sui IntentReceived event. */
export interface ReceivedDetails {
  srcEid: number;
  committedBlobId: string;
  deadline: number;
}

/** Result of a successful Walrus upload, persisted for idempotent retry. */
export interface UploadResult {
  walrusObjectId: string;
  walrusBlobId: string;
  endEpoch: number;
}
