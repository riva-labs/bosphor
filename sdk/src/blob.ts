/**
 * Client-side Walrus blob id computation.
 *
 * The blob id is derived locally from the raw bytes by `@mysten/walrus`
 * `encodeBlob`; it needs no SUI, no WAL, and no Sui RPC. Computing it client-side
 * lets the SDK put the exact same id on the commitment that the relayer recomputes
 * on ingest, so the two match byte for byte.
 *
 * `@mysten/walrus` is a heavy, optional dependency. It is loaded through a lazy
 * dynamic import so that (a) non-EVM or codec-only consumers never pull it, and
 * (b) unit tests can inject a stub `computeBlob` and never trigger the import.
 */

import { bytesToHex } from "@noble/hashes/utils.js";
import type { BlobEncoding, ComputeBlob, Hex } from "./types.js";
import { base64UrlToBytes } from "./base64.js";

/**
 * Convert a Walrus base64url blob id into the canonical 32-byte Bosphor commitment
 * field.
 *
 * A Walrus blob id is a `u256`. Its base64url string form encodes that integer in
 * LITTLE-endian byte order (this is exactly what `@mysten/walrus`'s `blobIdToInt`
 * decodes). The Bosphor commitment stores the blob id like every other field: as a
 * big-endian integer. So the canonical field is the big-endian encoding of the
 * Walrus `u256`, i.e. the base64url bytes reversed.
 *
 * Getting this right is what makes the on-chain reference check pass: Sui reads the
 * committed field big-endian (`bytes32_to_u256`), and `walrus::blob::blob_id()`
 * returns the same `u256`, so `committed_blob_id == blob.blob_id()`. Pinned to the
 * `@mysten/walrus` ground truth by `blob.test.ts`.
 */
function base64UrlToBytes32Hex(base64url: string): Hex {
  const bytes = base64UrlToBytes(base64url);
  if (bytes.length !== 32) {
    throw new Error(
      `expected a 32-byte Walrus blob id, decoded ${bytes.length} bytes from "${base64url}"`,
    );
  }
  // Little-endian base64url bytes -> big-endian commitment field. reverse()
  // mutates the freshly decoded array in place, which is fine here.
  bytes.reverse();
  return `0x${bytesToHex(bytes)}`;
}

/** Walrus network. The RedStuff encoding (hence the blob id) depends on it. */
export type WalrusNetwork = "testnet" | "mainnet";

const WALRUS_FULLNODE: Record<WalrusNetwork, string> = {
  testnet: "https://fullnode.testnet.sui.io",
  mainnet: "https://fullnode.mainnet.sui.io",
};

/**
 * Build a `@mysten/walrus`-backed blob-id computation bound to a specific network.
 * Lazily imports the Walrus SDK on first use; `encodeBlob` derives the id offline,
 * so no network call is made. Because the RedStuff encoding depends on the
 * network's shard count, the blob id differs between testnet and mainnet, so the
 * network is explicit here. A mainnet consumer MUST use
 * `createDefaultComputeBlob("mainnet")` (or pass a custom `computeBlob`); using the
 * testnet default on mainnet would commit a wrong blob id.
 *
 * If `@mysten/walrus` is not installed, this throws loudly with guidance rather
 * than silently fabricating an id.
 */
export function createDefaultComputeBlob(network: WalrusNetwork): ComputeBlob {
  return async (data: Uint8Array): Promise<BlobEncoding> => {
    // Import specifiers are held in variables so TypeScript does not try to resolve
    // (and typecheck) the optional peers at compile time. They are only pulled in at
    // runtime, when a consumer actually opts into the real Walrus-backed impl.
    const walrusSpec = "@mysten/walrus";
    const grpcSpec = "@mysten/sui/grpc";

    /* eslint-disable @typescript-eslint/no-explicit-any */
    let walrusMod: any;
    let grpcMod: any;
    try {
      [walrusMod, grpcMod] = await Promise.all([import(walrusSpec), import(grpcSpec)]);
    } catch (err) {
      throw new Error(
        "computeBlob requires the optional peer dependencies '@mysten/walrus' and " +
          "'@mysten/sui'. Install them (npm install @mysten/walrus @mysten/sui) or " +
          `pass a custom computeBlob to the client. Underlying error: ${String(err)}`,
      );
    }

    // The relayer computes the same id via `client.walrus.encodeBlob`. Mirror that
    // exact seam, a `SuiGrpcClient` extended with `walrus()` exactly as the relayer
    // builds it, so the client-computed id matches the relayer's recomputation byte
    // for byte. `encodeBlob` derives the id locally from the bytes; no RPC is made,
    // so the base URL is never contacted here.
    const suiClient = new grpcMod.SuiGrpcClient({
      network,
      baseUrl: WALRUS_FULLNODE[network],
    }).$extend(walrusMod.walrus());
    const { blobId } = await suiClient.walrus.encodeBlob(new Uint8Array(data));
    /* eslint-enable @typescript-eslint/no-explicit-any */

    return {
      blobId: base64UrlToBytes32Hex(blobId),
      size: data.length,
      // Walrus RedStuff is encoding type 0 (the only Walrus encoding today).
      encodingType: 0,
    };
  };
}

/**
 * The default, testnet-bound blob-id computation. Kept for back-compat; for
 * mainnet use `createDefaultComputeBlob("mainnet")` or pass a custom `computeBlob`.
 */
export const defaultComputeBlob: ComputeBlob = createDefaultComputeBlob("testnet");

export { base64UrlToBytes32Hex };
