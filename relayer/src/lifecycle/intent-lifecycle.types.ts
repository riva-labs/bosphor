/**
 * The six hops an intent travels on its cross-chain round trip. Ordered by the
 * lifecycle: EVM submit -> LZ delivery to Sui -> Walrus store -> Sui record ->
 * LZ proof back -> EVM confirm. `status` on a record is the furthest hop reached.
 */
export type IntentHop =
  | 'submitted'
  | 'received'
  | 'stored_walrus'
  | 'recorded_sui'
  | 'proof_sent'
  | 'confirmed';

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
  createdAt: number;
  updatedAt: number;
}
