// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { BosphorProof } from "../src/BosphorProof.sol";
import { IBosphorAdapter } from "../src/interfaces/IBosphorAdapter.sol";

/// @title BosphorProofTest
/// @notice Verifies that BosphorProof decodes execution proofs exactly as the
///         adapter encodes them, so integrating contracts read the same bytes the
///         adapter emitted in `IntentExecuted`.
contract BosphorProofTest is Test {
    /// @dev Mirrors the encoding BosphorAdapter performs in `_lzReceive` /
    ///      `_markExecuted`: `proof = abi.encode(blobId, endEpoch)`.
    function encodeAdapterProof(bytes32 blobId, uint256 endEpoch) internal pure returns (bytes memory) {
        return abi.encode(blobId, endEpoch);
    }

    function test_decode_roundTrips() public pure {
        bytes32 blobId = bytes32(uint256(0xABCDEF));
        uint256 endEpoch = 42;

        bytes memory proof = abi.encode(blobId, endEpoch);
        (bytes32 gotBlobId, uint256 gotEndEpoch) = BosphorProof.decode(proof);

        assertEq(gotBlobId, blobId);
        assertEq(gotEndEpoch, endEpoch);
    }

    /// @dev The proof decoded by the library must equal what the adapter would emit
    ///      for the same fields, proving parity between producer and consumer.
    function test_decode_matchesAdapterEmittedProof() public pure {
        bytes32 blobId = keccak256("some-walrus-blob");
        uint256 endEpoch = 1_000_000;

        bytes memory emitted = encodeAdapterProof(blobId, endEpoch);
        (bytes32 gotBlobId, uint256 gotEndEpoch) = BosphorProof.decode(emitted);

        assertEq(gotBlobId, blobId);
        assertEq(gotEndEpoch, endEpoch);
    }

    function testFuzz_decode_roundTrips(bytes32 blobId, uint256 endEpoch) public pure {
        bytes memory proof = abi.encode(blobId, endEpoch);
        (bytes32 gotBlobId, uint256 gotEndEpoch) = BosphorProof.decode(proof);
        assertEq(gotBlobId, blobId);
        assertEq(gotEndEpoch, endEpoch);
    }

    function test_decode_revertsOnWrongLength() public {
        bytes memory tooShort = abi.encodePacked(bytes32(uint256(1)));
        vm.expectRevert(BosphorProof.InvalidProofLength.selector);
        this.decodeExternal(tooShort);
    }

    /// @dev External wrapper so `vm.expectRevert` can catch the library revert.
    function decodeExternal(bytes memory proof) external pure returns (bytes32, uint256) {
        return BosphorProof.decode(proof);
    }

    function test_verified_decodesWhenExecuted() public pure {
        bytes32 blobId = keccak256("executed-blob");
        uint256 endEpoch = 7;
        bytes memory proof = abi.encode(blobId, endEpoch);

        (bytes32 gotBlobId, uint256 gotEndEpoch) = BosphorProof.verified(true, proof);
        assertEq(gotBlobId, blobId);
        assertEq(gotEndEpoch, endEpoch);
    }

    function test_verified_revertsWhenNotExecuted() public {
        bytes memory proof = abi.encode(bytes32(uint256(1)), uint256(1));
        vm.expectRevert(IBosphorAdapter.IntentNotFound.selector);
        this.verifiedExternal(false, proof);
    }

    /// @dev External wrapper so `vm.expectRevert` can catch the library revert.
    function verifiedExternal(bool executedFlag, bytes memory proof)
        external
        pure
        returns (bytes32, uint256)
    {
        return BosphorProof.verified(executedFlag, proof);
    }
}
