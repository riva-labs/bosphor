/**
 * The six hops an intent travels on its cross-chain round trip. Ordered by the
 * lifecycle: EVM submit -> LZ delivery to Sui -> Walrus store -> Sui record ->
 * LZ proof back -> EVM confirm. `status` on a record is the furthest hop reached.
 */
export type IntentHop =
  'submitted' | 'received' | 'stored_walrus' | 'recorded_sui' | 'proof_sent' | 'confirmed';

/** Optional per-hop context captured as an intent progresses. */
export interface HopDetails {
  /** EVM tx hash or Sui digest that produced this hop. */
  txHash?: string;
  /** EVM sender address, set on the first hop. */
  sender?: string;
  /** Walrus blob id (set at stored_walrus). */
  blobId?: string;
  /** Sui object id of the Walrus blob (set at stored_walrus). */
  suiObjectId?: string;
  /** Walrus storage expiry epoch (set at stored_walrus). */
  endEpoch?: number;
  /**
   * Committed Walrus blob id from the on-chain IntentSubmitted event, as a 0x
   * hex bytes32. In M3 the raw bytes travel out-of-band, so this commitment is
   * what ingest binds the received bytes to (set at submitted).
   */
  committedBlobId?: string;
  /** Committed blob size in bytes from IntentSubmitted (set at submitted). */
  size?: number;
  /** Intent deadline in epoch ms from IntentSubmitted (set at submitted). */
  deadline?: number;
  /**
   * WAL spent to store this intent's blob, in MIST. Metering hook for the
   * Milestone 4 user-pays model; recorded at stored_walrus when known.
   */
  walCostMist?: string;
  /** Hop time in epoch ms. Defaults to now when omitted. */
  timestamp?: number;
}

/** A single hop entry within an intent's lifecycle. */
export interface IntentHopRecord {
  hop: IntentHop;
  timestamp: number;
  txHash?: string;
}

/** The assembled lifecycle of one intent, newest-first in the feed. */
export interface IntentLifecycleRecord {
  intentId: string;
  status: IntentHop;
  hops: IntentHopRecord[];
  sender?: string;
  blobId?: string;
  suiObjectId?: string;
  endEpoch?: number;
  /** On-chain committed blob id (0x hex bytes32). See HopDetails.committedBlobId. */
  committedBlobId?: string;
  /** Committed blob size in bytes. */
  size?: number;
  /** Intent deadline in epoch ms. */
  deadline?: number;
  /** WAL spent to store the blob, in MIST (metering hook for M4 user-pays). */
  walCostMist?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * The on-chain commitment recorded at IntentSubmitted, used by the ingest path
 * to bind out-of-band bytes to what the sender committed to. A subset of the
 * lifecycle record, exposed so ingest does not depend on the full feed shape.
 */
export interface IntentCommitment {
  intentId: string;
  /** Committed Walrus blob id as a 0x hex bytes32. */
  committedBlobId: string;
  /** Committed blob size in bytes. */
  size: number;
  /** Intent deadline in epoch ms. */
  deadline: number;
  /** EVM sender that submitted the intent; receives the blob on Sui. */
  sender?: string;
  /** Furthest hop reached; ingest uses this to detect already-executed intents. */
  status: IntentHop;
}
