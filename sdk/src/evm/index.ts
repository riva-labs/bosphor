/**
 * `@bosphor/sdk/evm` subpath: the EVM origin client and its one-call `store()`.
 *
 * Re-exports the core codec and shared types too, so an EVM consumer needs only
 * this one import. `ethers` is an optional peer dependency: the consumer passes an
 * `ethers.Contract`, but this module never imports `ethers` directly.
 */

export {
  BosphorEvmClient,
  createBosphorClient,
  ProofTimeoutError,
  RelayerUploadError,
  decodeProofEndEpoch,
} from "./client.ts";
export type {
  AdapterContract,
  BosphorEvmClientOptions,
  EncodeOptions,
  AwaitProofOptions,
  EncodedIntent,
  MessagingFee,
  FetchLike,
  EvmLog,
  EvmContractTransaction,
  EvmTransactionReceipt,
} from "./client.ts";

export { defaultComputeBlob, base64UrlToBytes32Hex } from "../blob.ts";

// Re-export the core so `@bosphor/sdk/evm` is self-sufficient.
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
