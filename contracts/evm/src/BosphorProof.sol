// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IBosphorAdapter } from "./interfaces/IBosphorAdapter.sol";

/// @title BosphorProof
/// @author Riva Labs
/// @notice Small importable helper library for contract authors consuming Bosphor
///         execution proofs. When an intent executes, BosphorAdapter emits
///         `IntentExecuted(intentId, proof)` where `proof = abi.encode(bytes32 blobId,
///         uint256 endEpoch)`. This library decodes that proof and reads execution
///         state from the adapter, so integrating contracts do not have to re-derive
///         the encoding by hand.
/// @dev The proof format is frozen and matches BosphorAdapter `_lzReceive`:
///
///          proof = abi.encode(bytes32 blobId, uint256 endEpoch)
///
///      All functions are `internal` so they inline into the consumer and add no
///      external call surface of their own beyond the single `executed` view.
library BosphorProof {
    /// @notice Thrown when a proof byte string is not the expected 64-byte
    ///         `abi.encode(bytes32, uint256)` shape.
    error InvalidProofLength();

    /// @notice Decodes a Bosphor execution proof into its committed fields.
    /// @dev Inverse of the `abi.encode(blobId, endEpoch)` performed by the adapter
    ///      when it marks an intent executed. Reverts with `InvalidProofLength` if
    ///      `proof` is not exactly 64 bytes.
    /// @param proof The opaque proof bytes emitted by `IntentExecuted`.
    /// @return blobId The Walrus blob id the intent stored.
    /// @return endEpoch The Walrus epoch at which the stored blob expires.
    function decode(bytes memory proof) internal pure returns (bytes32 blobId, uint256 endEpoch) {
        if (proof.length != 64) revert InvalidProofLength();
        (blobId, endEpoch) = abi.decode(proof, (bytes32, uint256));
    }

    /// @notice Reads whether an intent has executed on the given adapter.
    /// @param adapter The BosphorAdapter to query.
    /// @param intentId The deterministic intent identifier.
    /// @return executedFlag True if the intent has been marked executed.
    function read(IBosphorAdapter adapter, bytes32 intentId)
        internal
        view
        returns (bool executedFlag)
    {
        return adapter.executed(intentId);
    }

    /// @notice Convenience helper: given an execution flag and a proof, returns the
    ///         decoded fields only when the intent has actually executed.
    /// @dev Guards a consumer against acting on a proof for an intent that has not
    ///      executed. Reverts with `IntentNotFound` (from `IBosphorAdapter`) when
    ///      `executedFlag` is false, otherwise decodes the proof.
    /// @param executedFlag Whether the intent has executed (e.g. from {read}).
    /// @param proof The opaque proof bytes emitted by `IntentExecuted`.
    /// @return blobId The Walrus blob id the intent stored.
    /// @return endEpoch The Walrus epoch at which the stored blob expires.
    function verified(bool executedFlag, bytes memory proof)
        internal
        pure
        returns (bytes32 blobId, uint256 endEpoch)
    {
        if (!executedFlag) revert IBosphorAdapter.IntentNotFound();
        (blobId, endEpoch) = decode(proof);
    }
}
