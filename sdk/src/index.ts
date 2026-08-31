/**
 * `@bosphor/sdk` core entry point.
 *
 * The core is chain-agnostic: it exports the commitment codec (the frozen wire
 * format and intentId derivation, shared byte for byte with the Solidity and Move
 * implementations) and the shared types used across chain-specific subpaths.
 *
 * Chain SDKs live behind subpaths so a consumer only pulls what they use:
 *   - `@bosphor/sdk`        core codec + shared types (no chain SDK)
 *   - `@bosphor/sdk/evm`    the EVM client and one-call `store()` (opt-in ethers)
 *   - `@bosphor/sdk/solana` the Solana client and one-call `store()` (opt-in web3.js)
 */

export {
  COMMITMENT_VERSION,
  COMMITMENT_BYTES,
  BLOB_ID_BYTES,
  SENDER_BYTES,
  encodeCommitment,
  decodeCommitment,
  deriveIntentId,
} from "./commitment-codec.js";
export type { Commitment } from "./commitment-codec.js";

export type { BlobEncoding, ComputeBlob, Hex, StoreResult } from "./types.js";

// Typed error hierarchy: catch `BosphorError` once, narrow on the subclass.
export {
  BosphorError,
  ProofTimeoutError,
  RelayerUploadError,
  UnsupportedCommitmentVersionError,
} from "./errors.js";

// Shared store-flow vocabulary (identical on every chain subpath).
export type { EncodeOptions, AwaitProofOptions, EncodedIntent, FetchLike } from "./store-flow.js";
