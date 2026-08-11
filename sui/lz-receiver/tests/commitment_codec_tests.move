/// Cross-chain parity tests for bosphor_lz::commitment_codec.
///
/// Iterates the frozen parity vectors in bosphor_lz::commitment_vectors and
/// asserts that encode, decode, and derive_intent_id match the expected bytes
/// byte-for-byte. These vectors are shared with the TypeScript SDK, so a
/// failure here signals a cross-chain wire-format divergence.
#[test_only]
module bosphor_lz::commitment_codec_tests;

use bosphor_lz::commitment_codec;
use bosphor_lz::commitment_vectors;

/// encode(...) did not match the vector's commitment bytes.
const EEncodeMismatch: u64 = 100;
/// decode(...) returned a blob_id that did not match.
const EDecodeBlobIdMismatch: u64 = 101;
/// decode(...) returned a size that did not match.
const EDecodeSizeMismatch: u64 = 102;
/// decode(...) returned an encoding_type that did not match.
const EDecodeEncodingTypeMismatch: u64 = 103;
/// decode(...) returned a storage_epochs that did not match.
const EDecodeStorageEpochsMismatch: u64 = 104;
/// decode(...) returned a deadline that did not match.
const EDecodeDeadlineMismatch: u64 = 105;
/// derive_intent_id(...) did not match the vector's intent_id bytes.
const EIntentIdMismatch: u64 = 106;

#[test]
fun parity_vectors() {
    let vectors = commitment_vectors::all();
    let mut i = 0;
    while (i < vectors.length()) {
        let v = vectors.borrow(i);

        // encode parity
        let encoded = commitment_codec::encode(
            v.blob_id(),
            v.size(),
            v.encoding_type(),
            v.storage_epochs(),
            v.deadline(),
        );
        assert!(encoded == v.commitment(), EEncodeMismatch + i);

        // decode parity (inverse of encode)
        let commitment = v.commitment();
        let (blob_id, size, encoding_type, storage_epochs, deadline) =
            commitment_codec::decode(&commitment);
        assert!(blob_id == v.blob_id(), EDecodeBlobIdMismatch + i);
        assert!(size == v.size(), EDecodeSizeMismatch + i);
        assert!(encoding_type == v.encoding_type(), EDecodeEncodingTypeMismatch + i);
        assert!(storage_epochs == v.storage_epochs(), EDecodeStorageEpochsMismatch + i);
        assert!(deadline == v.deadline(), EDecodeDeadlineMismatch + i);

        // intent id parity
        let intent_id = commitment_codec::derive_intent_id(
            v.blob_id(),
            v.size(),
            v.encoding_type(),
            v.storage_epochs(),
            v.deadline(),
            v.sender(),
            v.nonce(),
        );
        assert!(intent_id == v.intent_id(), EIntentIdMismatch + i);

        i = i + 1;
    };
}
