/**
 * `@bosphor/sdk/evm` subpath: the EVM origin client and its one-call `store()`.
 *
 * Re-exports the core codec and shared types too, so an EVM consumer needs only
 * this one import. `ethers` is an optional peer dependency: the consumer passes an
 * `ethers.Contract`, but this module never imports `ethers` directly.
 */

export { BosphorEvmClient, createBosphorClient, decodeProofEndEpoch } from "./client.js";
export { fromEthersContract } from "./adapter.js";
export { ADAPTER_ABI, EscrowStatus } from "./abi.js";
export { connectAdapter, createBosphorClientFromSigner } from "./signer.js";
export { quoteEvmStore } from "./quote-store.js";
export type { QuoteEvmStoreOptions } from "./quote-store.js";
export type {
  EthersRunnerLike,
  EthersSignerLike,
  EthersModuleLike,
  ConnectAdapterOptions,
  CreateClientFromSignerOptions,
} from "./signer.js";
export type { EthersContractLike, FromEthersContractOptions } from "./adapter.js";
export type {
  AdapterContract,
  BosphorEvmClientOptions,
  MessagingFee,
  EscrowRecord,
  RawEscrowRecord,
  EvmLog,
  EvmContractTransaction,
  EvmTransactionReceipt,
} from "./client.js";

// Typed error hierarchy (shared across chains).
export { BosphorError, ProofTimeoutError, RelayerUploadError } from "../errors.js";

// Shared store-flow types (identical on every chain).
export type {
  EncodeOptions,
  AwaitProofOptions,
  EncodedIntent,
  FetchLike,
  StoreProgress,
  ProgressOptions,
} from "../store-flow.js";

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

// Network presets: addresses, endpoint ids, and URLs for the hosted testnet.
export { TESTNET, networks, walrusBlobUrl, blobIdToBase64Url } from "../networks.js";
export type {
  BosphorNetwork,
  EvmNetworkConfig,
  SolanaNetworkConfig,
  SuiNetworkConfig,
} from "../networks.js";

// Off-chain priced quoting via the relayer (shared across chains).
export { fetchQuote } from "../quote.js";
export type {
  OriginToken,
  QuoteRequest,
  QuoteBreakdown,
  PricedQuote,
  FetchQuoteOptions,
  StoreSize,
} from "../quote.js";
