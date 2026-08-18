import { test } from "node:test";
import assert from "node:assert/strict";
import { base64UrlToBytes32Hex } from "./blob.js";

// Ground truth: a Walrus blob id is a u256 whose base64url string encodes it
// LITTLE-endian. The canonical Bosphor commitment field is the BIG-endian encoding
// of that u256, so `bytes32_to_u256(field)` on Sui equals `blob.blob_id()`.
//
// These pairs were captured directly from `@mysten/walrus`'s `blobIdToInt`
// (`u256 = blobIdToInt(id)`); `base64UrlToBytes32Hex(id)` must equal the big-endian
// encoding of that u256. Regenerate with:
//   node -e "import('@mysten/walrus').then(w => console.log(w.blobIdToInt('<id>')))"
const GROUND_TRUTH: ReadonlyArray<{ id: string; u256: bigint }> = [
  {
    id: "qineIE9eC8z5CTaTsILV-LL_8VwRVCK-lKZftG7B4ik",
    u256: 18945469250188461666138618653723572925962216957594918951120327912677430929834n,
  },
  {
    id: "C8PS3IT9ICqfchEnlef3gJfjLGm3clG-_tQp87R_hUM",
    u256: 30540832914878911192651214601507033741500283192320129193135672354919293305611n,
  },
];

test("base64UrlToBytes32Hex encodes the Walrus blob-id u256 big-endian", () => {
  for (const { id, u256 } of GROUND_TRUTH) {
    const hex = base64UrlToBytes32Hex(id);
    // The field, read as a big-endian integer, must equal the Walrus u256 (which is
    // exactly what on-chain `blob.blob_id()` returns).
    assert.equal(BigInt(hex), u256, `big-endian field must equal blobIdToInt for ${id}`);
    assert.equal(hex, `0x${u256.toString(16).padStart(64, "0")}`);
  }
});

test("base64UrlToBytes32Hex rejects ids that are not 32 bytes", () => {
  assert.throws(() => base64UrlToBytes32Hex("AAAA"), /32-byte Walrus blob id/);
});
