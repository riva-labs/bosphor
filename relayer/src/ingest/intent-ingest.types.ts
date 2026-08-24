/**
 * Typed outcomes of binding out-of-band bytes to an on-chain commitment.
 *
 * M3 moved the blob data off the LayerZero message: the intent carries only a
 * commitment, and the raw bytes reach the relayer out-of-band. Before spending
 * any WAL the relayer must prove the received bytes are exactly what the sender
 * committed to. Each rejection carries a distinct, machine-readable reason so
 * the HTTP layer can map it to a precise status code.
 */
export type IngestRejectReason =
  | 'unknown'
  | 'already-executed'
  | 'expired'
  | 'oversized'
  | 'wrong-size'
  | 'wrong-blob-id'
  | 'backpressure';

/** Accepted: the bytes match the commitment and are now buffered for storage. */
export interface IngestAccepted {
  ok: true;
  intentId: string;
  /** Recomputed Walrus blob id (base64url) that matched the commitment. */
  blobId: string;
  /** Byte length of the accepted blob. */
  size: number;
}

/** Rejected: the bytes did not bind to the commitment. */
export interface IngestRejected {
  ok: false;
  intentId: string;
  reason: IngestRejectReason;
  /** Human-readable detail for logs and the HTTP body. */
  message: string;
}

export type IngestResult = IngestAccepted | IngestRejected;
