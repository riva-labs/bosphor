// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title CommitmentCodec
/// @author Riva Labs
/// @notice Pure library that encodes, decodes, and derives intent identifiers for
///         Bosphor storage commitments. The wire format is frozen and shared byte
///         for byte with the TypeScript and Move implementations.
/// @dev Canonical commitment layout, 49 bytes, big-endian:
///
///          blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
///
///      The intent identifier binds a commitment to a sender and nonce:
///
///          intentId = keccak256(commitment(49) ++ sender(32, left-padded BE) ++ nonce(u64 BE))
///
///      On EVM an address is left-padded from 20 to 32 bytes before hashing. This
///      library takes the sender already in its canonical 32-byte form.
library CommitmentCodec {
    /// @notice Number of bytes in the canonical encoded commitment.
    uint256 internal constant COMMITMENT_LENGTH = 49;

    /// @notice Thrown when decode receives a byte string that is not exactly 49 bytes.
    error InvalidCommitmentLength();

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

    /// @notice Encodes a commitment into its canonical 49-byte big-endian form.
    /// @param c The commitment to encode.
    /// @return The 49-byte packed commitment.
    function encode(Commitment memory c) internal pure returns (bytes memory) {
        bytes memory out = abi.encodePacked(c.blobId, c.size, c.encodingType, c.storageEpochs, c.deadline);
        // Invariant: the fixed-width fields sum to exactly 49 bytes.
        assert(out.length == COMMITMENT_LENGTH);
        return out;
    }

    /// @notice Decodes a canonical 49-byte commitment back into its fields.
    /// @dev Reverts with InvalidCommitmentLength if data is not exactly 49 bytes.
    /// @param data The 49-byte packed commitment.
    /// @return c The decoded commitment.
    function decode(bytes memory data) internal pure returns (Commitment memory c) {
        if (data.length != COMMITMENT_LENGTH) revert InvalidCommitmentLength();

        bytes32 blobId;
        uint32 size;
        uint8 encodingType;
        uint32 storageEpochs;
        uint64 deadline;

        // Layout offsets within the packed bytes (after the 32-byte length word):
        //   [0..32)  blobId, [32..36) size, [36..37) encodingType,
        //   [37..41) storageEpochs, [41..49) deadline.
        assembly {
            let ptr := add(data, 0x20)
            blobId := mload(ptr)
            // size: shift the u32 that starts at byte 32 down to the low bits.
            size := shr(224, mload(add(ptr, 32)))
            encodingType := shr(248, mload(add(ptr, 36)))
            storageEpochs := shr(224, mload(add(ptr, 37)))
            deadline := shr(192, mload(add(ptr, 41)))
        }

        c = Commitment({
            blobId: blobId,
            size: size,
            encodingType: encodingType,
            storageEpochs: storageEpochs,
            deadline: deadline
        });
    }

    /// @notice Derives the intent identifier for a commitment bound to a sender and nonce.
    /// @dev Hashes the packed commitment, the 32-byte sender, and the 8-byte nonce.
    /// @param c The commitment.
    /// @param sender The canonical 32-byte sender (EVM addresses left-padded to 32 bytes).
    /// @param nonce The sender's monotonic intent nonce.
    /// @return The keccak256 intent identifier.
    function deriveIntentId(Commitment memory c, bytes32 sender, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(encode(c), sender, nonce));
    }
}
