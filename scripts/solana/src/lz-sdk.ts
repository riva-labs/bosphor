/**
 * The LayerZero Solana SDK and web3.js as resolved from scripts/solana, for code
 * outside this package (the priced e2e) that hands them to the Bosphor SDK's
 * fee quote. The SDK's own dynamic import resolves from sdk/src, where these
 * optional peers are not installed.
 */
export * as lzSdk from "@layerzerolabs/lz-solana-sdk-v2";
export * as web3 from "@solana/web3.js";
