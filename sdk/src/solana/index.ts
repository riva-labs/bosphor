/**
 * `@bosphor/sdk/solana` subpath: the Solana origin client and its one-call
 * `store()`, the same one-line API as the EVM path.
 *
 * Re-exports the core codec and shared types too, so a Solana consumer needs only
 * this one import. `@solana/web3.js` is an optional peer
 * dependency: the default backend (`createDefaultSolanaChain`) loads them via a
 * lazy dynamic import, and unit tests inject a fake `SolanaChain`. This module
 * itself never imports the Solana stack, so a codec-only or EVM-only consumer never
 * pulls it.
 *
 * @module
 */

export { BosphorSolanaClient, createBosphorSolanaClient } from "./client.js";
export type {
  SolanaChain,
  SolanaSubmitFields,
  SolanaSubmitResult,
  SolanaIntentState,
  SolanaEscrowState,
  BosphorSolanaClientOptions,
  SubmitOptions,
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
// Integrator attribution header (set via the client `appId` option).
export { APP_ID_HEADER } from "../store-flow.js";

export {
  decodeIntentState,
  readSolanaProof,
  INTENT_STATE_LEN,
} from "./proof.js";
export type { DecodedIntentState } from "./proof.js";

export { createDefaultSolanaChain, BOSPHOR_PROGRAM_ID } from "./backend.js";
export type { DefaultSolanaChainOptions, SolanaAccountMetaInput } from "./backend.js";

// Wallet-free store quote.
export { quoteSolanaStore } from "./quote-store.js";
export type { QuoteSolanaStoreOptions } from "./quote-store.js";

// Read-only LayerZero fee quote (simulated endpoint `quote`).
export { quoteSolanaLzFee, LzSolanaSdkMissingError, FORWARD_MESSAGE_LEN } from "./lz-fee.js";
export type { QuoteSolanaLzFeeOptions } from "./lz-fee.js";

// LayerZero send accounts + one-call client from a Keypair.
export {
  PAYER_PLACEHOLDER,
  TESTNET_SEND_ACCOUNTS,
  testnetEndpointAccounts,
  resolveEndpointAccounts,
  createBosphorSolanaClientFromKeypair,
} from "./endpoint-accounts.js";
export type {
  PublicKeyLike,
  LzSolanaSdkLike,
  ResolveEndpointAccountsOptions,
  CreateSolanaClientFromKeypairOptions,
} from "./endpoint-accounts.js";

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
