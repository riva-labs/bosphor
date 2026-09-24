/**
 * Network presets: every address, endpoint id, and URL a Bosphor integration
 * needs, in one place, so a consumer never has to hand-copy them from the docs.
 *
 * `TESTNET` is the hosted public testnet (Ethereum Sepolia and Solana devnet as
 * origin chains, Sui testnet + Walrus testnet as the storage side). Pass it (or a
 * field of it) to the chain helpers in `@bosphor/sdk/evm` and
 * `@bosphor/sdk/solana`. Mainnet is not open for integrations yet, so it is not
 * exported here.
 */

import type { WalrusNetwork } from "./blob.js";
import type { Hex } from "./types.js";

/** EVM origin-chain settings for a network. */
export interface EvmNetworkConfig {
  /** Human-readable chain name. */
  chainName: string;
  /** EVM chain id (e.g. 11155111 for Sepolia). */
  chainId: number;
  /** A public RPC URL for the chain (rate limited; bring your own for production). */
  rpcUrl: string;
  /** LayerZero endpoint id of this EVM chain. */
  eid: number;
  /** The deployed Bosphor escrow adapter contract. */
  adapterAddress: string;
  /** The LayerZero EndpointV2 contract on this chain. */
  lzEndpoint: string;
  /**
   * LayerZero executor options for `submitIntent` (type-3, lzReceive gas 200k).
   * The adapter has no enforced options, so an empty `0x` reverts the quote.
   */
  lzOptions: Hex;
  /** Block explorer base URL (no trailing slash). */
  explorerUrl: string;
}

/** Solana origin-chain settings for a network. */
export interface SolanaNetworkConfig {
  /** Solana cluster name. */
  cluster: string;
  /** A public RPC URL for the cluster (rate limited; bring your own for production). */
  rpcUrl: string;
  /** LayerZero endpoint id of this Solana cluster. */
  eid: number;
  /** The deployed Bosphor Solana adapter program id (base58). */
  programId: string;
  /** The LayerZero v2 endpoint program id (base58). */
  lzEndpointProgram: string;
  /** The LayerZero v2 ULN302 send/receive library program id (base58). */
  lzUlnProgram: string;
  /** LayerZero executor options for `submit_intent` (type-3, lzReceive gas 200k). */
  lzOptions: Hex;
  /**
   * Upper bound (lamports) on the LayerZero messaging fee passed with
   * `submit_intent`. The endpoint aborts if this is below the live quote.
   */
  nativeFee: bigint;
  /** Compute-unit limit for the submit transaction (the LZ `send` CPI needs ~400k). */
  computeUnitLimit: number;
}

/** Destination (Sui + Walrus) settings for a network. */
export interface SuiNetworkConfig {
  /** LayerZero endpoint id of Sui. */
  eid: number;
  /** The Bosphor Sui package id: the LayerZero peer of every origin adapter. */
  packageId: Hex;
}

/** A complete Bosphor network preset. */
export interface BosphorNetwork {
  /** Preset name. */
  name: "testnet";
  /** Base URL of the hosted relayer (quotes, blob upload, status). */
  relayerUrl: string;
  /** Walrus network used for blob-id derivation. */
  walrusNetwork: WalrusNetwork;
  /** Walrus aggregator base URL for reading stored blobs. */
  walrusAggregatorUrl: string;
  /** LayerZero Scan base URL for tracking cross-chain messages. */
  layerZeroScanUrl: string;
  /** Destination chain (Sui + Walrus). */
  sui: SuiNetworkConfig;
  /** Ethereum origin chain. */
  evm: EvmNetworkConfig;
  /** Solana origin chain. */
  solana: SolanaNetworkConfig;
}

/** Type-3 LayerZero executor options: lzReceive with 200k gas and 0 value. */
const LZ_RECEIVE_200K: Hex = "0x00030100110100000000000000000000000000030d40";

/** The hosted Bosphor public testnet. */
export const TESTNET: BosphorNetwork = {
  name: "testnet",
  relayerUrl: "https://api.bosphor.xyz/testnet",
  walrusNetwork: "testnet",
  walrusAggregatorUrl: "https://aggregator.walrus-testnet.walrus.space",
  layerZeroScanUrl: "https://testnet.layerzeroscan.com",
  sui: {
    eid: 40378,
    packageId: "0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5",
  },
  evm: {
    chainName: "Ethereum Sepolia",
    chainId: 11155111,
    rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",
    eid: 40161,
    adapterAddress: "0x3296686Fc61076d27488278c1da5468E1e0A7156",
    lzEndpoint: "0x6EDCE65403992e310A62460808c4b910D972f10f",
    lzOptions: LZ_RECEIVE_200K,
    explorerUrl: "https://sepolia.etherscan.io",
  },
  solana: {
    cluster: "devnet",
    rpcUrl: "https://api.devnet.solana.com",
    eid: 40168,
    programId: "7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF",
    lzEndpointProgram: "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6",
    lzUlnProgram: "7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH",
    lzOptions: LZ_RECEIVE_200K,
    nativeFee: 10_000_000n,
    computeUnitLimit: 400_000,
  },
};

/** All presets by name. */
export const networks: { readonly testnet: BosphorNetwork } = { testnet: TESTNET };

/**
 * Walrus aggregator URL that serves a stored blob, given the 0x-hex blob id the
 * SDK returns (`StoreResult.blobId`). Converts it to the base64url form Walrus
 * uses.
 */
export function walrusBlobUrl(blobId: Hex, network: BosphorNetwork = TESTNET): string {
  return `${network.walrusAggregatorUrl}/v1/blobs/${blobIdToBase64Url(blobId)}`;
}

/**
 * Convert the SDK's 0x-hex blob id (big-endian commitment field) into the Walrus
 * base64url blob id (little-endian). The inverse of `base64UrlToBytes32Hex`.
 */
export function blobIdToBase64Url(blobId: Hex): string {
  const hex = blobId.startsWith("0x") ? blobId.slice(2) : blobId;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`expected a 32-byte 0x-hex blob id, got "${blobId}"`);
  }
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[31 - i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
