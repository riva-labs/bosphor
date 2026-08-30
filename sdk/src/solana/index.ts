/**
 * `@bosphor/sdk/solana` subpath: the Solana origin client and its one-call
 * `store()`, the same one-line API as the EVM path.
 *
 * Re-exports the core codec and shared types too, so a Solana consumer needs only
 * this one import. `@solana/web3.js` is an optional peer
 * dependencies: the default backend (`createDefaultSolanaChain`) loads them via a
 * lazy dynamic import, and unit tests inject a fake `SolanaChain`. This module
 * itself never imports the Solana stack, so a codec-only or EVM-only consumer never
 * pulls it.
 */

export { BosphorSolanaClient, createBosphorSolanaClient } from "./client.js";
export type {
  SolanaChain,
  SolanaSubmitFields,
  SolanaSubmitResult,
  SolanaIntentState,
  BosphorSolanaClientOptions,
  SubmitOptions,
} from "./client.js";

// Typed error hierarchy (shared across chains).
export { BosphorError, ProofTimeoutError, RelayerUploadError } from "../errors.js";

// Shared store-flow types (identical on every chain).
export type { EncodeOptions, AwaitProofOptions, EncodedIntent, FetchLike } from "../store-flow.js";

export {
  decodeIntentState,
  readSolanaProof,
  INTENT_STATE_LEN,
} from "./proof.js";
export type { DecodedIntentState } from "./proof.js";

export { createDefaultSolanaChain, BOSPHOR_PROGRAM_ID } from "./backend.js";
export type { DefaultSolanaChainOptions } from "./backend.js";

export { defaultComputeBlob, createDefaultComputeBlob, base64UrlToBytes32Hex } from "../blob.js";
export type { WalrusNetwork } from "../blob.js";

// Re-export the core so `@bosphor/sdk/solana` is self-sufficient.
export {
  COMMITMENT_BYTES,
  BLOB_ID_BYTES,
  SENDER_BYTES,
  encodeCommitment,
  decodeCommitment,
  deriveIntentId,
} from "../commitment-codec.js";
export type { Commitment } from "../commitment-codec.js";
export type { BlobEncoding, ComputeBlob, Hex, StoreResult } from "../types.js";
