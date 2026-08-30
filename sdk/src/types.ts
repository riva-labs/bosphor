/**
 * Shared, chain-agnostic types for the Bosphor SDK.
 *
 * These live in the core (not under a chain subpath) so both the EVM client and a
 * future Solana client speak the same vocabulary for blob encoding and results.
 */

/** A 0x-prefixed hex string. */
export type Hex = `0x${string}`;

/**
 * The result of encoding raw bytes for Walrus storage: the derived blob id (as a
 * 0x-hex bytes32, matching the on-chain commitment), the byte size, and the Walrus
 * encoding type discriminator. Computed locally from the bytes; no network needed.
 */
export interface BlobEncoding {
  /** 32-byte Walrus blob id as 0x hex, ready to pass to `submitIntent`. */
  blobId: Hex;
  /** Raw blob size in bytes. */
  size: number;
  /** Walrus encoding type discriminator. */
  encodingType: number;
}

/**
 * Injectable blob-id computation seam. The real implementation wraps
 * `@mysten/walrus` `encodeBlob`; tests inject a deterministic stub so unit tests
 * never load the Walrus SDK or contact a Sui RPC.
 */
export type ComputeBlob = (data: Uint8Array) => Promise<BlobEncoding>;

/**
 * The outcome of a completed `store()`: the intent id, the committed blob id, and
 * the Walrus epoch at which the stored blob expires. All three are verified against
 * on-chain state before `store()` resolves; none are fabricated.
 */
export interface StoreResult {
  /** Deterministic keccak256 intent identifier. */
  intentId: Hex;
  /** Committed Walrus blob id, echoed from the verified execution proof. */
  blobId: Hex;
  /** Walrus epoch at which the stored blob expires. */
  endEpoch: bigint;
  /** Origin-chain transaction hash (EVM) or signature (Solana) of the submit. */
  txHash?: string;
}
