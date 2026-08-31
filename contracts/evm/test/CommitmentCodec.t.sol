// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { CommitmentCodec } from "../src/CommitmentCodec.sol";

/// @title CommitmentCodecTest
/// @notice Parity test for the Bosphor commitment codec against the frozen
///         cross-language oracle in shared/parity/commitment-vectors.json.
/// @dev The oracle is the single source of truth shared with the TypeScript and
///      Move implementations. Every vector must byte-match on encode and intentId.
contract CommitmentCodecTest is Test {
    using CommitmentCodec for CommitmentCodec.Commitment;

    /// @dev One oracle vector held as raw JSON strings/numbers. We parse each field
    ///      with a typed cheatcode rather than abi.decode a whole object, because
    ///      forge coerces numeric-looking string fields (the u64 decimal bigints
    ///      deadline and nonce) inconsistently, which corrupts struct decoding for
    ///      large values such as the max_fields vector.
    struct Vec {
        string name;
        string blobId; // 32-byte hex, no 0x prefix
        uint256 size;
        uint256 encodingType;
        uint256 storageEpochs;
        string deadline; // u64 decimal string
        string sender; // 20- or 32-byte hex, no 0x prefix
        string nonce; // u64 decimal string
        string commitment; // 50-byte hex, no 0x prefix
        string intentId; // 32-byte hex, no 0x prefix
    }

    /// @dev One negative oracle vector: a full-length commitment whose version
    ///      byte is not supported. Decode must revert with the typed error.
    struct InvalidVec {
        string name;
        uint256 version;
        string commitment; // 50-byte hex, no 0x prefix
    }

    Vec[] internal vectors;
    InvalidVec[] internal invalidVectors;

    function setUp() public {
        string memory json = vm.readFile("../../shared/parity/commitment-vectors.json");
        // Derive the vector count from a wildcard query over a plain string field.
        string[] memory names = abi.decode(vm.parseJson(json, ".vectors[*].name"), (string[]));
        for (uint256 i = 0; i < names.length; i++) {
            string memory p = string.concat(".vectors[", vm.toString(i), "]");
            vectors.push(
                Vec({
                    name: vm.parseJsonString(json, string.concat(p, ".name")),
                    blobId: vm.parseJsonString(json, string.concat(p, ".blobId")),
                    size: vm.parseJsonUint(json, string.concat(p, ".size")),
                    encodingType: vm.parseJsonUint(json, string.concat(p, ".encodingType")),
                    storageEpochs: vm.parseJsonUint(json, string.concat(p, ".storageEpochs")),
                    deadline: vm.parseJsonString(json, string.concat(p, ".deadline")),
                    sender: vm.parseJsonString(json, string.concat(p, ".sender")),
                    nonce: vm.parseJsonString(json, string.concat(p, ".nonce")),
                    commitment: vm.parseJsonString(json, string.concat(p, ".commitment")),
                    intentId: vm.parseJsonString(json, string.concat(p, ".intentId"))
                })
            );
        }
        assertGt(vectors.length, 0, "no vectors loaded");

        string[] memory invalidNames = abi.decode(vm.parseJson(json, ".invalidVectors[*].name"), (string[]));
        for (uint256 i = 0; i < invalidNames.length; i++) {
            string memory p = string.concat(".invalidVectors[", vm.toString(i), "]");
            invalidVectors.push(
                InvalidVec({
                    name: vm.parseJsonString(json, string.concat(p, ".name")),
                    version: vm.parseJsonUint(json, string.concat(p, ".version")),
                    commitment: vm.parseJsonString(json, string.concat(p, ".commitment"))
                })
            );
        }
        assertGt(invalidVectors.length, 0, "no invalid vectors loaded");
    }

    function test_EncodeMatchesOracle() public view {
        for (uint256 i = 0; i < vectors.length; i++) {
            Vec memory v = vectors[i];
            bytes memory encoded = _toCommitment(v).encode();
            assertEq(encoded.length, 50, string.concat("length != 50 for ", v.name));
            assertEq(uint8(encoded[0]), CommitmentCodec.COMMITMENT_VERSION, string.concat("version byte for ", v.name));
            assertEq(encoded, _hexToBytes(v.commitment), string.concat("commitment mismatch for ", v.name));
        }
    }

    function test_DecodeRoundTrips() public view {
        for (uint256 i = 0; i < vectors.length; i++) {
            Vec memory v = vectors[i];
            CommitmentCodec.Commitment memory c = _toCommitment(v);

            CommitmentCodec.Commitment memory back = CommitmentCodec.decode(c.encode());
            assertEq(back.blobId, c.blobId, string.concat("blobId roundtrip for ", v.name));
            assertEq(back.size, c.size, string.concat("size roundtrip for ", v.name));
            assertEq(back.encodingType, c.encodingType, string.concat("encodingType roundtrip for ", v.name));
            assertEq(back.storageEpochs, c.storageEpochs, string.concat("storageEpochs roundtrip for ", v.name));
            assertEq(back.deadline, c.deadline, string.concat("deadline roundtrip for ", v.name));
        }
    }

    function test_DeriveIntentIdMatchesOracle() public view {
        for (uint256 i = 0; i < vectors.length; i++) {
            Vec memory v = vectors[i];
            bytes32 sender = _leftPadToBytes32(_hexToBytes(v.sender));
            uint64 nonce = uint64(vm.parseUint(v.nonce));

            bytes32 got = _toCommitment(v).deriveIntentId(sender, nonce);
            bytes32 expected = vm.parseBytes32(string.concat("0x", v.intentId));
            assertEq(got, expected, string.concat("intentId mismatch for ", v.name));
        }
    }

    function test_DecodeRevertsOnWrongLength() public {
        // Route through an external call so expectRevert sees the revert at a
        // lower depth than the internal (inlined) library function would produce.
        // 49 bytes is the legacy unversioned length and must be rejected.
        vm.expectRevert(CommitmentCodec.InvalidCommitmentLength.selector);
        this.decodeExternal(new bytes(49));

        vm.expectRevert(CommitmentCodec.InvalidCommitmentLength.selector);
        this.decodeExternal(new bytes(51));
    }

    function test_DecodeRevertsOnUnsupportedVersionOracle() public {
        for (uint256 i = 0; i < invalidVectors.length; i++) {
            InvalidVec memory v = invalidVectors[i];
            vm.expectRevert(
                abi.encodeWithSelector(CommitmentCodec.UnsupportedCommitmentVersion.selector, uint8(v.version))
            );
            this.decodeExternal(_hexToBytes(v.commitment));
        }
    }

    function test_DecodeRevertsOnUnsupportedVersion() public {
        // A well-formed 50-byte commitment with a tampered version byte.
        bytes memory encoded = _toCommitment(vectors[0]).encode();
        encoded[0] = 0xff;
        vm.expectRevert(abi.encodeWithSelector(CommitmentCodec.UnsupportedCommitmentVersion.selector, uint8(0xff)));
        this.decodeExternal(encoded);
    }

    /// @dev External wrapper so decode reverts can be asserted with expectRevert.
    function decodeExternal(bytes memory data) external pure returns (CommitmentCodec.Commitment memory) {
        return CommitmentCodec.decode(data);
    }

    // --- Helpers ---

    function _toCommitment(Vec memory v) internal pure returns (CommitmentCodec.Commitment memory) {
        return CommitmentCodec.Commitment({
            blobId: vm.parseBytes32(string.concat("0x", v.blobId)),
            size: uint32(v.size),
            encodingType: uint8(v.encodingType),
            storageEpochs: uint32(v.storageEpochs),
            deadline: uint64(vm.parseUint(v.deadline))
        });
    }

    function _hexToBytes(string memory hexStr) internal pure returns (bytes memory) {
        return vm.parseBytes(string.concat("0x", hexStr));
    }

    /// @dev Right-aligns a variable-length (<= 32) byte string into a bytes32,
    ///      zero-padding on the left. Matches the canonical 32-byte sender form
    ///      used for both EVM addresses (20 bytes) and Sui addresses (32 bytes).
    function _leftPadToBytes32(bytes memory b) internal pure returns (bytes32 out) {
        require(b.length <= 32, "sender > 32 bytes");
        uint256 offset = 32 - b.length;
        bytes memory buf = new bytes(32);
        for (uint256 i = 0; i < b.length; i++) {
            buf[offset + i] = b[i];
        }
        assembly {
            out := mload(add(buf, 32))
        }
    }
}
