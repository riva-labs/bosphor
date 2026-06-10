/// Bosphor LayerZero Proof Message Codec
///
/// Encodes and decodes type-1 proof messages exchanged between Sui and EVM
/// via LayerZero. Wire format:
/// `bytes1(0x01) ++ intentId(32) ++ blobId(32) ++ endEpoch(32, big-endian u256)`
module bosphor_lz::codec;

// === Errors ===

/// intent_id must be exactly 32 bytes.
const EInvalidIntentIdLength: u64 = 0;
/// blob_id must be exactly 32 bytes.
const EInvalidBlobIdLength: u64 = 1;
/// Decoded message must be exactly 97 bytes.
const EInvalidMessageLength: u64 = 2;
/// First byte of the message must be 0x01 (type-1).
const EInvalidMessageType: u64 = 3;

// === Structs ===

/// Ephemeral encoding helper for proof messages.
///
/// drop only (no store/copy) because ProofMessage is an ephemeral encoding
/// helper, never persisted on-chain. Public visibility for future SDK import.
#[allow(unused_field)]
public struct ProofMessage has drop {
    intent_id: vector<u8>,
    blob_id: vector<u8>,
    end_epoch: u64,
}

// === Public-Mutative ===

// === Public-View ===

/// Builds the type-1 proof message with ABI-encoded payload.
///
/// Format: `[0x01] [intentId(32)] [blobId(32)] [endEpoch(32, left-padded u256)]`
/// Total: 97 bytes. Matches the EVM `_lzReceive` decoder for message type 1.
///
/// * `intent_id` - 32-byte intent identifier. Must be exactly 32 bytes.
/// * `blob_id` - 32-byte Walrus blob identifier. Must be exactly 32 bytes.
/// * `end_epoch` - Walrus storage epoch, encoded as big-endian uint256.
///
/// Aborts with `EInvalidIntentIdLength` if `intent_id` is not 32 bytes.
/// Aborts with `EInvalidBlobIdLength` if `blob_id` is not 32 bytes.
public fun encode(
    intent_id: vector<u8>,
    blob_id: vector<u8>,
    end_epoch: u64,
): vector<u8> {
    assert!(intent_id.length() == 32, EInvalidIntentIdLength);
    assert!(blob_id.length() == 32, EInvalidBlobIdLength);

    let mut msg = vector::empty<u8>();

    // Type 1 prefix
    msg.push_back(1u8);

    // intentId (32 bytes)
    let mut i = 0u64;
    while (i < 32) {
        msg.push_back(*intent_id.borrow(i));
        i = i + 1;
    };

    // blobId (32 bytes)
    i = 0;
    while (i < 32) {
        msg.push_back(*blob_id.borrow(i));
        i = i + 1;
    };

    // endEpoch as uint256 (big-endian, left-padded to 32 bytes)
    encode_u64_as_u256(&mut msg, end_epoch);

    msg
}

/// Decodes a 97-byte type-1 proof message into its components.
///
/// Extracts intent_id, blob_id, and end_epoch from the wire format:
///   byte 0: 0x01 (type prefix)
///   bytes 1-32: intent_id
///   bytes 33-64: blob_id
///   bytes 65-96: end_epoch as uint256 (big-endian)
///
/// * `message` - 97-byte encoded proof message.
///
/// Returns `(intent_id, blob_id, end_epoch)`.
///
/// Aborts with `EInvalidMessageLength` if message is not exactly 97 bytes.
/// Aborts with `EInvalidMessageType` if byte 0 is not 0x01.
public fun decode(message: &vector<u8>): (vector<u8>, vector<u8>, u64) {
    assert!(message.length() == 97, EInvalidMessageLength);
    assert!(*message.borrow(0) == 0x01, EInvalidMessageType);

    let intent_id = slice(message, 1, 32);
    let blob_id = slice(message, 33, 32);
    let end_epoch = decode_u64_from_u256(message, 65);

    (intent_id, blob_id, end_epoch)
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

/// Appends a u64 value as a 32-byte big-endian uint256 to `msg`.
///
/// First 24 bytes are zero-padding, then 8 bytes of big-endian u64.
fun encode_u64_as_u256(msg: &mut vector<u8>, value: u64) {
    // 24 zero-padding bytes
    let mut i = 0u64;
    while (i < 24) {
        msg.push_back(0u8);
        i = i + 1;
    };
    // 8 bytes of u64 in big-endian
    msg.push_back(((value >> 56) & 0xFF) as u8);
    msg.push_back(((value >> 48) & 0xFF) as u8);
    msg.push_back(((value >> 40) & 0xFF) as u8);
    msg.push_back(((value >> 32) & 0xFF) as u8);
    msg.push_back(((value >> 24) & 0xFF) as u8);
    msg.push_back(((value >> 16) & 0xFF) as u8);
    msg.push_back(((value >> 8) & 0xFF) as u8);
    msg.push_back((value & 0xFF) as u8);
}

/// Decodes a u64 from a 32-byte big-endian uint256 at the given offset.
///
/// Reads the last 8 bytes (offset+24..offset+32) as big-endian u64,
/// discarding the upper 24 bytes. Assumes the value fits in u64.
fun decode_u64_from_u256(data: &vector<u8>, offset: u64): u64 {
    let base = offset + 24;
    ((*data.borrow(base) as u64) << 56)
        | ((*data.borrow(base + 1) as u64) << 48)
        | ((*data.borrow(base + 2) as u64) << 40)
        | ((*data.borrow(base + 3) as u64) << 32)
        | ((*data.borrow(base + 4) as u64) << 24)
        | ((*data.borrow(base + 5) as u64) << 16)
        | ((*data.borrow(base + 6) as u64) << 8)
        | (*data.borrow(base + 7) as u64)
}
