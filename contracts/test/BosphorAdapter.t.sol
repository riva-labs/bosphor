// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BosphorAdapter.sol";
import "./mocks/EndpointV2Mock.sol";

contract BosphorAdapterTest is Test {
    BosphorAdapter adapter;
    EndpointV2Mock endpoint;
    address relayer = address(0xBEEF);
    address user = address(0xCAFE);
    address attacker = address(0xDEAD);

    uint32 constant DST_EID = 30378; // Sui EID
    bytes32 constant PEER = bytes32(uint256(0x1234));

    function setUp() public {
        endpoint = new EndpointV2Mock();
        adapter = new BosphorAdapter(address(endpoint), address(this), relayer);
        adapter.setPeer(DST_EID, PEER);
    }

    // --- helpers ---

    function _defaultOptions() internal pure returns (bytes memory) {
        return hex"0003010011010000000000000000000000000000c350"; // lzReceive gas 50000
    }

    function _submitIntent(address sender, bytes memory payload, uint256 deadline) internal returns (bytes32) {
        uint256 fee = endpoint.NATIVE_FEE();
        vm.deal(sender, fee);
        vm.prank(sender);
        return adapter.submitIntent{value: fee}(DST_EID, payload, deadline, _defaultOptions());
    }

    // --- submitIntent ---

    function test_submitIntent_success() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        assertTrue(adapter.intents(intentId));
        assertEq(adapter.intentDeadlines(intentId), deadline);
        assertEq(adapter.nonces(user), 1);
    }

    function test_submitIntent_expiredDeadline_reverts() public {
        uint256 fee = endpoint.NATIVE_FEE();
        vm.deal(user, fee);
        vm.prank(user);
        vm.expectRevert(BosphorAdapter.DeadlineExpired.selector);
        adapter.submitIntent{value: fee}(DST_EID, "hello", block.timestamp - 1, _defaultOptions());
    }

    function test_submitIntent_incrementsNonce() public {
        uint256 deadline = block.timestamp + 1 hours;
        _submitIntent(user, "a", deadline);
        _submitIntent(user, "b", deadline);

        assertEq(adapter.nonces(user), 2);
    }

    function test_submitIntent_uniqueIds() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 id1 = _submitIntent(user, "a", deadline);
        bytes32 id2 = _submitIntent(user, "a", deadline); // same payload, different nonce

        assertTrue(id1 != id2);
    }

    // --- confirmExecution (owner-only emergency fallback) ---

    function test_confirmExecution_success() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        // Test contract is the owner
        adapter.confirmExecution(intentId, "proof");

        assertTrue(adapter.executed(intentId));
    }

    function test_confirmExecution_unauthorizedCaller_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        adapter.confirmExecution(intentId, "proof");
    }

    function test_confirmExecution_replayAttack_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        // Owner calls twice
        adapter.confirmExecution(intentId, "proof");

        vm.expectRevert(BosphorAdapter.AlreadyExecuted.selector);
        adapter.confirmExecution(intentId, "proof");
    }

    function test_confirmExecution_nonExistentIntent_reverts() public {
        vm.expectRevert(BosphorAdapter.IntentNotFound.selector);
        adapter.confirmExecution(bytes32(uint256(999)), "proof");
    }

    function test_confirmExecution_afterDeadline_succeeds() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.warp(deadline + 1);

        adapter.confirmExecution(intentId, "proof");
        assertTrue(adapter.executed(intentId));
    }

    function test_confirmExecution_relayer_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.prank(relayer);
        vm.expectRevert("Ownable: caller is not the owner");
        adapter.confirmExecution(intentId, "proof");
    }

    // --- setRelayer ---

    function test_setRelayer_success() public {
        address newRelayer = address(0xFACE);
        adapter.setRelayer(newRelayer);
        assertEq(adapter.trustedRelayer(), newRelayer);
    }

    function test_setRelayer_onlyOwner_reverts() public {
        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        adapter.setRelayer(attacker);
    }

    function test_setRelayer_zeroAddress_reverts() public {
        vm.expectRevert(BosphorAdapter.ZeroAddress.selector);
        adapter.setRelayer(address(0));
    }

    function test_constructor_zeroRelayer_reverts() public {
        vm.expectRevert(BosphorAdapter.ZeroAddress.selector);
        new BosphorAdapter(address(endpoint), address(this), address(0));
    }

    // --- getIntentId ---

    function test_getIntentId_matches_submitIntent() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 submitted = _submitIntent(user, "hello", deadline);

        bytes32 computed = adapter.getIntentId(user, uint64(DST_EID), "hello", 0, deadline);
        assertEq(submitted, computed);
    }

    // --- LayerZero receive (proof via LZ, legacy tests updated to type 1) ---

    function test_lzReceive_marks_executed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        bytes32 blobId = keccak256("lz-proof-data");
        uint256 endEpoch = 10;
        bytes memory message = _buildType1Message(intentId, blobId, endEpoch);

        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        assertTrue(adapter.executed(intentId));
    }

    function test_lzReceive_replayAttack_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        bytes32 blobId = keccak256("lz-proof");
        uint256 endEpoch = 10;
        bytes memory message = _buildType1Message(intentId, blobId, endEpoch);

        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        // Second attempt should revert
        vm.expectRevert();
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
    }

    // --- LayerZero receive: type 1 proof (new format) ---

    function _buildType1Message(
        bytes32 intentId,
        bytes32 blobId,
        uint256 endEpoch
    ) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(0x01), abi.encode(intentId, blobId, endEpoch));
    }

    function test_lzReceive_type1_marks_executed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        bytes32 blobId = keccak256("walrus-blob-123");
        uint256 endEpoch = 42;
        bytes memory message = _buildType1Message(intentId, blobId, endEpoch);

        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        assertTrue(adapter.executed(intentId));
    }

    function test_lzReceive_type1_duplicate_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        bytes32 blobId = keccak256("walrus-blob-123");
        uint256 endEpoch = 42;
        bytes memory message = _buildType1Message(intentId, blobId, endEpoch);

        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        vm.expectRevert(BosphorAdapter.AlreadyExecuted.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
    }

    function test_lzReceive_type1_nonExistent_reverts() public {
        bytes32 fakeId = bytes32(uint256(999));
        bytes memory message = _buildType1Message(fakeId, bytes32(0), 1);

        vm.expectRevert(BosphorAdapter.IntentNotFound.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
    }

    function test_lzReceive_type1_afterDeadline_succeeds() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.warp(deadline + 1);

        bytes32 blobId = keccak256("walrus-blob-123");
        bytes memory message = _buildType1Message(intentId, blobId, 42);

        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
        assertTrue(adapter.executed(intentId));
    }

    function test_lzReceive_emptyMessage_reverts() public {
        vm.expectRevert(BosphorAdapter.UnknownMessageType.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, "");
    }

    function test_lzReceive_unknownType_reverts() public {
        // Type 0
        bytes memory msgType0 = bytes.concat(bytes1(0x00), abi.encode(bytes32(0), bytes32(0), uint256(0)));
        vm.expectRevert(BosphorAdapter.UnknownMessageType.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, msgType0);

        // Type 2
        bytes memory msgType2 = bytes.concat(bytes1(0x02), abi.encode(bytes32(0), bytes32(0), uint256(0)));
        vm.expectRevert(BosphorAdapter.UnknownMessageType.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, msgType2);
    }

    function test_lzReceive_type1_emits_event() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        bytes32 blobId = keccak256("walrus-blob-123");
        uint256 endEpoch = 42;

        vm.expectEmit(true, false, false, true);
        emit BosphorAdapter.IntentExecuted(intentId, abi.encode(blobId, endEpoch));

        endpoint.simulateLzReceive(
            address(adapter), DST_EID, PEER,
            _buildType1Message(intentId, blobId, endEpoch)
        );
    }

    // --- quote ---

    function test_quote_returns_fee() public view {
        uint256 deadline = block.timestamp + 1 hours;
        MessagingFee memory fee = adapter.quote(DST_EID, "hello", deadline, _defaultOptions());
        assertEq(fee.nativeFee, endpoint.NATIVE_FEE());
        assertEq(fee.lzTokenFee, 0);
    }
}
