// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CommitmentCodec
/// @author Riva Labs
/// @notice Pure library that encodes, decodes, and derives intent identifiers for
///         Bosphor storage commitments. The wire format is versioned and shared byte
///         for byte with the TypeScript, Move, and Rust implementations.
/// @dev Canonical commitment layout, 50 bytes, big-endian, format version 1:
///
///          version(u8=1) ++ blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
///
///      The leading version byte lets the format evolve without coordinated
///      redeploys: decode rejects any version it does not understand instead of
///      silently misreading the bytes that follow.
///
///      The intent identifier binds a commitment to a sender and nonce and covers
///      the versioned bytes:
///
///          intentId = keccak256(commitment(50) ++ sender(32, left-padded BE) ++ nonce(u64 BE))
///
///      On EVM an address is left-padded from 20 to 32 bytes before hashing. This
///      library takes the sender already in its canonical 32-byte form.
library CommitmentCodec {
    /// @notice The single commitment wire-format version this library understands.
    uint8 internal constant COMMITMENT_VERSION = 1;

    /// @notice Number of bytes in the canonical encoded commitment.
    uint256 internal constant COMMITMENT_LENGTH = 50;

    /// @notice Thrown when decode receives a byte string that is not exactly 50 bytes.
    error InvalidCommitmentLength();

    /// @notice Thrown when decode receives a commitment whose version byte is not supported.
    /// @param version The unsupported version byte found at offset 0.
    error UnsupportedCommitmentVersion(uint8 version);

    /// @notice A Bosphor storage commitment, referencing a Walrus blob and its terms.
    /// @param blobId Walrus blob identifier.
    /// @param size Blob size in bytes.
    /// @param encodingType Walrus encoding type discriminator.
    /// @param storageEpochs Number of Walrus epochs the blob is stored for.
    /// @param deadline Unix timestamp by which execution must complete.
    struct Commitment {
        bytes32 blobId;
        uint32 size;
        uint8 encodingType;
        uint32 storageEpochs;
        uint64 deadline;
    }

    /// @notice Encodes a commitment into its canonical 50-byte big-endian version-1 form.
    /// @param c The commitment to encode.
    /// @return The 50-byte packed commitment, starting with the version byte.
    function encode(Commitment memory c) internal pure returns (bytes memory) {
        bytes memory out =
            abi.encodePacked(COMMITMENT_VERSION, c.blobId, c.size, c.encodingType, c.storageEpochs, c.deadline);
        // Invariant: the version byte plus the fixed-width fields sum to exactly 50 bytes.
        assert(out.length == COMMITMENT_LENGTH);
        return out;
    }

    /// @notice Decodes a canonical 50-byte version-1 commitment back into its fields.
    /// @dev Reverts with InvalidCommitmentLength if data is not exactly 50 bytes and
    ///      with UnsupportedCommitmentVersion if the version byte is not 1.
    /// @param data The 50-byte packed commitment.
    /// @return c The decoded commitment.
    function decode(bytes memory data) internal pure returns (Commitment memory c) {
        if (data.length != COMMITMENT_LENGTH) revert InvalidCommitmentLength();

        uint8 version;
        bytes32 blobId;
        uint32 size;
        uint8 encodingType;
        uint32 storageEpochs;
        uint64 deadline;

        // Layout offsets within the packed bytes (after the 32-byte length word):
        //   [0]      version, [1..33) blobId, [33..37) size, [37..38) encodingType,
        //   [38..42) storageEpochs, [42..50) deadline.
        assembly {
            let ptr := add(data, 0x20)
            version := shr(248, mload(ptr))
            blobId := mload(add(ptr, 1))
            // size: shift the u32 that starts at byte 33 down to the low bits.
            size := shr(224, mload(add(ptr, 33)))
            encodingType := shr(248, mload(add(ptr, 37)))
            storageEpochs := shr(224, mload(add(ptr, 38)))
            deadline := shr(192, mload(add(ptr, 42)))
        }

        if (version != COMMITMENT_VERSION) revert UnsupportedCommitmentVersion(version);

        c = Commitment({
            blobId: blobId,
            size: size,
            encodingType: encodingType,
            storageEpochs: storageEpochs,
            deadline: deadline
        });
    }

    /// @notice Derives the intent identifier for a commitment bound to a sender and nonce.
    /// @dev Hashes the packed versioned commitment, the 32-byte sender, and the 8-byte nonce.
    /// @param c The commitment.
    /// @param sender The canonical 32-byte sender (EVM addresses left-padded to 32 bytes).
    /// @param nonce The sender's monotonic intent nonce.
    /// @return The keccak256 intent identifier.
    function deriveIntentId(Commitment memory c, bytes32 sender, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(encode(c), sender, nonce));
    }
}
