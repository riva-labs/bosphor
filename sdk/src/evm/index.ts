/**
 * `@bosphor/sdk/evm` subpath: the EVM origin client and its one-call `store()`.
 *
 * Re-exports the core codec and shared types too, so an EVM consumer needs only
 * this one import. `ethers` is an optional peer dependency: the consumer passes an
 * `ethers.Contract`, but this module never imports `ethers` directly.
 */

export { BosphorEvmClient, createBosphorClient, decodeProofEndEpoch } from "./client.js";
export { fromEthersContract } from "./adapter.js";
export type { EthersContractLike, FromEthersContractOptions } from "./adapter.js";
export type {
  AdapterContract,
  BosphorEvmClientOptions,
  MessagingFee,
  EvmLog,
  EvmContractTransaction,
  EvmTransactionReceipt,
} from "./client.js";

// Typed error hierarchy (shared across chains).
export { BosphorError, ProofTimeoutError, RelayerUploadError } from "../errors.js";

// Shared store-flow types (identical on every chain).
export type { EncodeOptions, AwaitProofOptions, EncodedIntent, FetchLike } from "../store-flow.js";

export { defaultComputeBlob, createDefaultComputeBlob, base64UrlToBytes32Hex } from "../blob.js";
export type { WalrusNetwork } from "../blob.js";

// Re-export the core so `@bosphor/sdk/evm` is self-sufficient.
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
