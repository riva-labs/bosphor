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

export {
  BosphorSolanaClient,
  createBosphorSolanaClient,
  ProofTimeoutError,
  RelayerUploadError,
} from "./client.ts";
export type {
  SolanaChain,
  SolanaSubmitFields,
  SolanaSubmitResult,
  SolanaIntentState,
  BosphorSolanaClientOptions,
  EncodeOptions,
  SubmitOptions,
  AwaitProofOptions,
  EncodedIntent,
  FetchLike,
} from "./client.ts";

export {
  decodeIntentState,
  readSolanaProof,
  INTENT_STATE_LEN,
} from "./proof.ts";
export type { DecodedIntentState } from "./proof.ts";

export { createDefaultSolanaChain, BOSPHOR_PROGRAM_ID } from "./backend.ts";
export type { DefaultSolanaChainOptions } from "./backend.ts";

export { defaultComputeBlob, base64UrlToBytes32Hex } from "../blob.ts";

// Re-export the core so `@bosphor/sdk/solana` is self-sufficient.
export {
  COMMITMENT_BYTES,
  BLOB_ID_BYTES,
  SENDER_BYTES,
  encodeCommitment,
  decodeCommitment,
  deriveIntentId,
} from "../commitment-codec.ts";
export type { Commitment } from "../commitment-codec.ts";
export type { BlobEncoding, ComputeBlob, Hex, StoreResult } from "../types.ts";
