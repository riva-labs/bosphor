/**
 * Canonical Walrus blob-id conversion for the Bosphor commitment / return proof.
 *
 * A Walrus blob id is a `u256`. Its base64url string form encodes that integer in
 * LITTLE-endian byte order (exactly what `@mysten/walrus`'s `blobIdToInt` decodes).
 * Every Bosphor commitment field is a big-endian integer, and Sui reads the blob-id
 * slot big-endian (`bytes32_to_u256`). So the canonical field is the BIG-endian
 * encoding of the Walrus u256, i.e. the base64url bytes reversed.
 *
 * This is the single source of truth for that boundary in the relayer. It must
 * match the SDK's `base64UrlToBytes32Hex` byte-for-byte so the client commitment,
 * the ingest re-check, and the return proof all agree with on-chain
 * `blob.blob_id()`. Pinned to the `@mysten/walrus` ground truth in the spec.
 */

/** Base64url Walrus blob id -> canonical 32-byte big-endian field. */
export function walrusBlobIdToField(base64url: string): Buffer {
  const le = Buffer.from(base64url, 'base64url');
  if (le.length !== 32) {
    throw new Error(
      `expected a 32-byte Walrus blob id, decoded ${le.length} bytes from "${base64url}"`,
    );
  }
  return Buffer.from(le).reverse();
}

/**
 * Compare a recomputed Walrus blob id (base64url) against an on-chain commitment
 * (0x hex bytes32). Both are reduced to the canonical big-endian field before
 * comparison, so this agrees with the on-chain `blob.blob_id()` check rather than
 * merely with the codec's own convention.
 */
export function blobIdMatches(recomputedBase64Url: string, committedHex: string): boolean {
  try {
    const field = walrusBlobIdToField(recomputedBase64Url);
    const committed = Buffer.from(committedHex.replace(/^0x/i, ''), 'hex');
    return committed.length === 32 && field.equals(committed);
  } catch {
    return false;
  }
}
