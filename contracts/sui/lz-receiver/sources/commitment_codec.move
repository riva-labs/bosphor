/// Bosphor Commitment Codec
///
/// Encodes, decodes, and derives intent identifiers for reference-based
/// storage intents. The commitment is a fixed 50-byte, big-endian record that
/// commits to a Walrus blob and its storage terms. Wire format (version 1):
/// `version(u8=1) ++ blob_id(32) ++ size(u32) ++ encoding_type(u8) ++ storage_epochs(u32) ++ deadline(u64)`
///
/// The leading version byte lets the format evolve without coordinated
/// redeploys: decode aborts on any version it does not understand instead of
/// silently misreading the bytes that follow.
///
/// The intent identifier binds a commitment to its origin sender and nonce and
/// covers the versioned bytes:
/// `intent_id = keccak256( commitment(50) ++ sender(32, left-padded) ++ nonce(u64 big-endian) )`
///
/// This layout is shared byte-for-byte with the TypeScript SDK, the Solidity
/// library, and the Rust crate. Any change here is a cross-chain wire-format
/// break and requires a new version.
module bosphor_lz::commitment_codec;

use sui::hash;

// === Constants ===

/// The single commitment wire-format version this module understands.
const COMMITMENT_VERSION: u8 = 1;
/// Total length of an encoded commitment in bytes.
const COMMITMENT_LEN: u64 = 50;
/// Length of a blob id in bytes.
const BLOB_ID_LEN: u64 = 32;
/// Length of the left-padded sender in the intent-id preimage.
const SENDER_PADDED_LEN: u64 = 32;

// === Errors ===

/// blob_id must be exactly 32 bytes.
const EInvalidBlobIdLength: u64 = 0;
/// Encoded commitment must be exactly 50 bytes.
const EInvalidCommitmentLength: u64 = 1;
/// sender must be at most 32 bytes so it can be left-padded to 32.
const EInvalidSenderLength: u64 = 2;
/// The commitment's version byte is not a version this module understands.
const EUnsupportedCommitmentVersion: u64 = 3;

// === Public-View ===

/// Encodes a commitment into its canonical 50-byte big-endian version-1 form.
///
/// Layout: `version(u8=1) ++ blob_id(32) ++ size(u32) ++ encoding_type(u8) ++ storage_epochs(u32) ++ deadline(u64)`.
/// `size` and `storage_epochs` are 4 big-endian bytes each, `deadline` is 8
/// big-endian bytes, `version` and `encoding_type` are a single byte each.
///
/// * `blob_id` - 32-byte Walrus blob identifier. Must be exactly 32 bytes.
/// * `size` - Blob size in bytes.
/// * `encoding_type` - Walrus encoding type discriminant.
/// * `storage_epochs` - Number of storage epochs to reserve.
/// * `deadline` - Intent execution deadline as a unix timestamp.
///
/// Aborts with `EInvalidBlobIdLength` if `blob_id` is not 32 bytes.
public fun encode(
    blob_id: vector<u8>,
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
): vector<u8> {
    assert!(blob_id.length() == BLOB_ID_LEN, EInvalidBlobIdLength);

    let mut out = vector::empty<u8>();

    // version (1 byte)
    out.push_back(COMMITMENT_VERSION);

    // blob_id (32 bytes)
    let mut i = 0u64;
    while (i < BLOB_ID_LEN) {
        out.push_back(*blob_id.borrow(i));
        i = i + 1;
    };

    // size (u32, 4 big-endian bytes)
    encode_u32_be(&mut out, size);
    // encoding_type (1 byte)
    out.push_back(encoding_type);
    // storage_epochs (u32, 4 big-endian bytes)
    encode_u32_be(&mut out, storage_epochs);
    // deadline (u64, 8 big-endian bytes)
    encode_u64_be(&mut out, deadline);

    out
}

/// Decodes a 50-byte version-1 commitment into its components.
///
/// Inverse of `encode`. Reads the fields in the canonical layout:
///   byte  0:     version (must be 1)
///   bytes 1-32:  blob_id
///   bytes 33-36: size (big-endian u32)
///   byte  37:    encoding_type
///   bytes 38-41: storage_epochs (big-endian u32)
///   bytes 42-49: deadline (big-endian u64)
///
/// * `data` - 50-byte encoded commitment.
///
/// Returns `(blob_id, size, encoding_type, storage_epochs, deadline)`.
///
/// Aborts with `EInvalidCommitmentLength` if `data` is not exactly 50 bytes.
/// Aborts with `EUnsupportedCommitmentVersion` if the version byte is not 1.
public fun decode(data: &vector<u8>): (vector<u8>, u32, u8, u32, u64) {
    assert!(data.length() == COMMITMENT_LEN, EInvalidCommitmentLength);
    assert!(*data.borrow(0) == COMMITMENT_VERSION, EUnsupportedCommitmentVersion);

    let blob_id = slice(data, 1, BLOB_ID_LEN);
    let size = decode_u32_be(data, 33);
    let encoding_type = *data.borrow(37);
    let storage_epochs = decode_u32_be(data, 38);
    let deadline = decode_u64_be(data, 42);

    (blob_id, size, encoding_type, storage_epochs, deadline)
}

/// Derives the intent identifier for a commitment, sender, and nonce.
///
/// Builds the preimage `encode(...) ++ left_pad_32(sender) ++ nonce(u64 big-endian)`
/// over the versioned 50-byte commitment and returns its keccak256 digest
/// (32 bytes). The sender is left-padded with zero bytes to 32 bytes, so a
/// 20-byte EVM address and a 32-byte Sui address hash consistently.
///
/// * `sender` - Origin sender bytes, at most 32 bytes (EVM 20 or Sui 32).
/// * `nonce` - Per-sender intent nonce.
///
/// Aborts with `EInvalidBlobIdLength` if `blob_id` is not 32 bytes.
/// Aborts with `EInvalidSenderLength` if `sender` is longer than 32 bytes.
public fun derive_intent_id(
    blob_id: vector<u8>,
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
    sender: vector<u8>,
    nonce: u64,
): vector<u8> {
    let mut preimage = encode(blob_id, size, encoding_type, storage_epochs, deadline);

    append_left_padded_sender(&mut preimage, &sender);
    encode_u64_be(&mut preimage, nonce);

    hash::keccak256(&preimage)
}

// === Private ===

/// Extracts a contiguous byte slice from `data` starting at `start` with length `len`.
fun slice(data: &vector<u8>, start: u64, len: u64): vector<u8> {
    let mut result = vector::empty<u8>();
    let mut i = 0;
    while (i < len) {
        result.push_back(*data.borrow(start + i));
        i = i + 1;
    };
    result
}

/// Appends a u32 value as 4 big-endian bytes to `out`.
fun encode_u32_be(out: &mut vector<u8>, value: u32) {
    out.push_back(((value >> 24) & 0xFF) as u8);
    out.push_back(((value >> 16) & 0xFF) as u8);
    out.push_back(((value >> 8) & 0xFF) as u8);
    out.push_back((value & 0xFF) as u8);
}

/// Appends a u64 value as 8 big-endian bytes to `out`.
fun encode_u64_be(out: &mut vector<u8>, value: u64) {
    out.push_back(((value >> 56) & 0xFF) as u8);
    out.push_back(((value >> 48) & 0xFF) as u8);
    out.push_back(((value >> 40) & 0xFF) as u8);
    out.push_back(((value >> 32) & 0xFF) as u8);
    out.push_back(((value >> 24) & 0xFF) as u8);
    out.push_back(((value >> 16) & 0xFF) as u8);
    out.push_back(((value >> 8) & 0xFF) as u8);
    out.push_back((value & 0xFF) as u8);
}

/// Reads a big-endian u32 from `data` at `offset`.
fun decode_u32_be(data: &vector<u8>, offset: u64): u32 {
    ((*data.borrow(offset) as u32) << 24)
        | ((*data.borrow(offset + 1) as u32) << 16)
        | ((*data.borrow(offset + 2) as u32) << 8)
        | (*data.borrow(offset + 3) as u32)
}

/// Reads a big-endian u64 from `data` at `offset`.
fun decode_u64_be(data: &vector<u8>, offset: u64): u64 {
    ((*data.borrow(offset) as u64) << 56)
        | ((*data.borrow(offset + 1) as u64) << 48)
        | ((*data.borrow(offset + 2) as u64) << 40)
        | ((*data.borrow(offset + 3) as u64) << 32)
        | ((*data.borrow(offset + 4) as u64) << 24)
        | ((*data.borrow(offset + 5) as u64) << 16)
        | ((*data.borrow(offset + 6) as u64) << 8)
        | (*data.borrow(offset + 7) as u64)
}

/// Appends `sender` to `out`, left-padded with zero bytes to 32 bytes.
///
/// Aborts with `EInvalidSenderLength` if `sender` is longer than 32 bytes.
fun append_left_padded_sender(out: &mut vector<u8>, sender: &vector<u8>) {
    let len = sender.length();
    assert!(len <= SENDER_PADDED_LEN, EInvalidSenderLength);

    // Left pad with zeros.
    let mut pad = SENDER_PADDED_LEN - len;
    while (pad > 0) {
        out.push_back(0u8);
        pad = pad - 1;
    };

    // Then the sender bytes.
    let mut i = 0u64;
    while (i < len) {
        out.push_back(*sender.borrow(i));
        i = i + 1;
    };
}
