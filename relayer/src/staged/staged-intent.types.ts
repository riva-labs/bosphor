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
  /** Sui digest of the delivery tx that emitted IntentReceived (the "Delivered to Sui" proof). */
  deliveryDigest?: string;
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
  /**
   * Process identity that currently holds (or last held) the claim lease.
   * Set atomically by the claim query; cleared when the row is rescheduled.
   * On terminal rows it is left as a historical record of who processed them.
   */
  claimedBy?: string;
  /** Epoch ms the current claim lease expires; past it, any process may claim. */
  leaseExpiresAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * A row that is IntentReceived but still has no bytes, eligible for byte recovery
 * (re-fetch the committed blob from Walrus). The commitment is enough to fetch and
 * re-verify the blob without the client.
 */
export interface ByteRecoveryCandidate {
  intentId: string;
  /** Committed blob id (0x hex big-endian) - the Walrus blob to re-fetch. */
  committedBlobId: string;
}

/**
 * Outcome of a byte upsert under atomic admission control.
 *   accepted     the bytes were buffered (row created or merged onto active row).
 *   backpressure the staged-byte cap would be exceeded; nothing was written.
 *   terminal     the row exists but is terminal (done/dead/expired); a no-op.
 */
export type UpsertOutcome = 'accepted' | 'backpressure' | 'terminal';

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
  /** Sui digest of the delivery tx that emitted the event. */
  deliveryDigest?: string;
}

/** Result of a successful Walrus upload, persisted for idempotent retry. */
export interface UploadResult {
  walrusObjectId: string;
  walrusBlobId: string;
  endEpoch: number;
}

/** Queue-depth snapshot for the metrics gauges. */
export interface StagedStats {
  /** Rows still in play (not yet done/dead/expired). */
  active: number;
  /** Rows dead-lettered (pre-store attempts exhausted or a terminal error). */
  dead: number;
  /** Total committed bytes still held in the queue (backpressure headroom). */
  bytes: number;
}
