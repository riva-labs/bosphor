/**
 * One completed Walrus storage op, as recorded in the durable ops ledger
 * (`storage_op_ledger`). Written exactly once per intent, at the point the store
 * completes (execute_store succeeded on Sui), and never reaped. This is the
 * evidence source for usage KPIs: ops by origin chain, bytes stored, unique
 * senders and integrator apps.
 *
 * All timestamps are epoch milliseconds, matching staged_intent and
 * intent_lifecycle.
 */
export interface StorageOpEntry {
  intentId: string;
  /** LayerZero endpoint id of the origin chain (e.g. 40161 Sepolia). */
  srcEid: number | null;
  /** Origin-chain sender that submitted the intent. */
  sender: string | null;
  /** Stored blob size in bytes. */
  size: number | null;
  /** Committed blob id from the origin intent (0x hex bytes32). */
  blobId: string | null;
  /** Walrus blob id of the stored blob (base64url). */
  walrusBlobId: string | null;
  /** Sui object id of the stored Walrus blob. */
  walrusObjectId: string | null;
  /** Walrus storage expiry epoch. */
  endEpoch: number | null;
  /** X-Bosphor-App integrator id, null when the client sent none. */
  appId: string | null;
  /** Deployment network label (SUI_NETWORK: testnet or mainnet). */
  network: string;
  /** Sui execute_store digest; null when only "already recorded" is known. */
  storeDigest: string | null;
  /** When the relayer first saw the intent (staged row creation). */
  createdAt: number;
  /** When execute_store completed. */
  storedAt: number;
}
