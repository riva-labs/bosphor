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

import type { BlobEncoding, ComputeBlob, Hex } from "./types.ts";

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
  const bytes = Buffer.from(base64url, "base64url");
  if (bytes.length !== 32) {
    throw new Error(
      `expected a 32-byte Walrus blob id, decoded ${bytes.length} bytes from "${base64url}"`,
    );
  }
  // Little-endian base64url bytes -> big-endian commitment field.
  const be = Buffer.from(bytes).reverse();
  return `0x${be.toString("hex")}`;
}

/**
 * The default, `@mysten/walrus`-backed blob-id computation. Lazily imports the
 * Walrus SDK on first use. The Walrus `WalrusClient.encodeBlob` API derives the id
 * offline, so this makes no network call.
 *
 * If `@mysten/walrus` is not installed (e.g. an offline install skipped the
 * optional chain SDK), this throws loudly with guidance rather than silently
 * fabricating an id.
 */
export const defaultComputeBlob: ComputeBlob = async (
  data: Uint8Array,
): Promise<BlobEncoding> => {
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
  // so the base URL is never contacted here. The network is fixed to testnet
  // because the RedStuff encoding depends on the network's shard count; a mainnet
  // consumer should pass a custom computeBlob built for mainnet.
  const suiClient = new grpcMod.SuiGrpcClient({
    network: "testnet",
    baseUrl: "https://fullnode.testnet.sui.io",
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

export { base64UrlToBytes32Hex };
