// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BosphorAdapter.sol";
import "../src/interfaces/IBosphorAdapter.sol";
import "../src/CommitmentCodec.sol";
import "./mocks/EndpointV2Mock.sol";

contract BosphorAdapterTest is Test {
    BosphorAdapter adapter;
    EndpointV2Mock endpoint;
    address relayer = address(0xBEEF);
    address user = address(0xCAFE);
    address attacker = address(0xDEAD);

    uint32 constant DST_EID = 30378; // Sui EID
    bytes32 constant PEER = bytes32(uint256(0x1234));

    // Default commitment fields used across tests.
    bytes32 constant BLOB_ID = bytes32(uint256(0xABCDEF));
    uint32 constant SIZE = 1024;
    uint8 constant ENCODING = 1;
    uint32 constant EPOCHS = 5;

    function setUp() public {
        endpoint = new EndpointV2Mock();
        adapter = new BosphorAdapter(address(endpoint), address(this), relayer);
        adapter.setPeer(DST_EID, PEER);
    }

    // --- helpers ---

    function _defaultOptions() internal pure returns (bytes memory) {
        return hex"0003010011010000000000000000000000000000c350"; // lzReceive gas 50000
    }

    function _submit(address sender, bytes32 blobId, uint64 deadline) internal returns (bytes32) {
        uint256 fee = endpoint.NATIVE_FEE();
        vm.deal(sender, fee);
        vm.prank(sender);
        return adapter.submitIntent{value: fee}(
            DST_EID, blobId, SIZE, ENCODING, EPOCHS, deadline, _defaultOptions()
        );
    }

    function _deriveId(address sender, bytes32 blobId, uint64 deadline, uint64 nonce)
        internal
        pure
        returns (bytes32)
    {
        CommitmentCodec.Commitment memory c =
            CommitmentCodec.Commitment(blobId, SIZE, ENCODING, EPOCHS, deadline);
        return CommitmentCodec.deriveIntentId(c, bytes32(uint256(uint160(sender))), nonce);
    }

    function _buildType1Message(
        bytes32 intentId,
        bytes32 blobId,
        uint256 endEpoch
    ) internal pure returns (bytes memory) {
        return bytes.concat(bytes1(0x01), abi.encode(intentId, blobId, endEpoch));
    }

    // --- submitIntent ---

    function test_submitIntent_success() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 expectedId = _deriveId(user, BLOB_ID, deadline, 0);

        vm.expectEmit(true, true, false, true);
        emit IBosphorAdapter.IntentSubmitted(
            expectedId, user, uint64(DST_EID), BLOB_ID, SIZE, ENCODING, EPOCHS, 0, deadline
        );

        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        assertEq(intentId, expectedId);
        assertTrue(adapter.intents(intentId));
        assertEq(adapter.committedBlobId(intentId), BLOB_ID);
        assertEq(adapter.intentDeadlines(intentId), deadline);
        assertEq(adapter.nonces(user), 1);
    }

    function test_submitIntent_expiredDeadline_reverts() public {
        uint256 fee = endpoint.NATIVE_FEE();
        vm.deal(user, fee);
        vm.prank(user);
        vm.expectRevert(IBosphorAdapter.DeadlineExpired.selector);
        adapter.submitIntent{value: fee}(
            DST_EID, BLOB_ID, SIZE, ENCODING, EPOCHS, uint64(block.timestamp - 1), _defaultOptions()
        );
    }

    function test_submitIntent_incrementsNonce() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        _submit(user, BLOB_ID, deadline);
        _submit(user, bytes32(uint256(0xBEEF01)), deadline);
        assertEq(adapter.nonces(user), 2);
    }

    function test_submitIntent_uniqueIds() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id1 = _submit(user, BLOB_ID, deadline);
        bytes32 id2 = _submit(user, BLOB_ID, deadline); // same commitment, different nonce
        assertTrue(id1 != id2);
    }

    // --- intentId determinism ---

    function test_getIntentId_matches_submitIntent() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 submitted = _submit(user, BLOB_ID, deadline);

        bytes32 computed =
            adapter.getIntentId(user, BLOB_ID, SIZE, ENCODING, EPOCHS, deadline, 0);
        assertEq(submitted, computed);
    }

    function test_getIntentId_matches_codec() public view {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 fromAdapter =
            adapter.getIntentId(user, BLOB_ID, SIZE, ENCODING, EPOCHS, deadline, 0);
        bytes32 fromCodec = _deriveId(user, BLOB_ID, deadline, 0);
        assertEq(fromAdapter, fromCodec);
    }

    // --- duplicate submit guard ---

    function test_submitIntent_duplicate_reverts() public {
        // The nonce increments on every submit, so a duplicate id cannot occur in normal
        // flow. Force the collision by locating the nonces slot for `user` and resetting it
        // to zero, so the second submit re-derives the first intent id and hits the guard.
        uint64 deadline = uint64(block.timestamp + 1 hours);
        _submit(user, BLOB_ID, deadline);
        assertEq(adapter.nonces(user), 1);

        bytes32 nonceSlot = _findNonceSlot(user);
        vm.store(address(adapter), nonceSlot, bytes32(0));
        assertEq(adapter.nonces(user), 0);

        uint256 fee = endpoint.NATIVE_FEE();
        vm.deal(user, fee);
        vm.prank(user);
        vm.expectRevert(IBosphorAdapter.IntentAlreadyExists.selector);
        adapter.submitIntent{value: fee}(
            DST_EID, BLOB_ID, SIZE, ENCODING, EPOCHS, deadline, _defaultOptions()
        );
    }

    /// @dev Locates the storage slot backing `nonces[account]` by scanning candidate base
    ///      slots and confirming with a round-trip write. This avoids hardcoding a layout
    ///      that shifts as parent contracts change. The account nonce is 1 on entry.
    function _findNonceSlot(address account) internal returns (bytes32) {
        for (uint256 base = 0; base < 64; base++) {
            bytes32 slot = keccak256(abi.encode(account, base));
            if (uint256(vm.load(address(adapter), slot)) != 1) continue;

            // Round-trip: write a sentinel, confirm nonces() reflects it, then restore.
            vm.store(address(adapter), slot, bytes32(uint256(7)));
            bool match_ = adapter.nonces(account) == 7;
            vm.store(address(adapter), slot, bytes32(uint256(1)));
            if (match_) return slot;
        }
        revert("nonce slot not found");
    }

    // --- confirmExecution (owner-only emergency fallback) ---

    function test_confirmExecution_success() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);
        adapter.confirmExecution(intentId, "proof");
        assertTrue(adapter.executed(intentId));
    }

    function test_confirmExecution_unauthorizedCaller_reverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        adapter.confirmExecution(intentId, "proof");
    }

    function test_confirmExecution_replayAttack_reverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        adapter.confirmExecution(intentId, "proof");
        vm.expectRevert(IBosphorAdapter.AlreadyExecuted.selector);
        adapter.confirmExecution(intentId, "proof");
    }

    function test_confirmExecution_nonExistentIntent_reverts() public {
        vm.expectRevert(IBosphorAdapter.IntentNotFound.selector);
        adapter.confirmExecution(bytes32(uint256(999)), "proof");
    }

    function test_confirmExecution_afterDeadline_succeeds() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        vm.warp(deadline + 1);
        adapter.confirmExecution(intentId, "proof");
        assertTrue(adapter.executed(intentId));
    }

    function test_confirmExecution_relayer_reverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

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
        vm.expectRevert(IBosphorAdapter.ZeroAddress.selector);
        adapter.setRelayer(address(0));
    }

    function test_constructor_zeroRelayer_reverts() public {
        vm.expectRevert(IBosphorAdapter.ZeroAddress.selector);
        new BosphorAdapter(address(endpoint), address(this), address(0));
    }

    // --- LayerZero receive: type 1 proof ---

    function test_lzReceive_type1_marks_executed() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        bytes memory message = _buildType1Message(intentId, BLOB_ID, 42);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        assertTrue(adapter.executed(intentId));
    }

    function test_lzReceive_type1_emits_event() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        uint256 endEpoch = 42;
        vm.expectEmit(true, false, false, true);
        emit IBosphorAdapter.IntentExecuted(intentId, abi.encode(BLOB_ID, endEpoch));

        endpoint.simulateLzReceive(
            address(adapter), DST_EID, PEER, _buildType1Message(intentId, BLOB_ID, endEpoch)
        );
    }

    function test_lzReceive_type1_blobIdMismatch_reverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        bytes32 wrongBlob = keccak256("not-the-committed-blob");
        bytes memory message = _buildType1Message(intentId, wrongBlob, 42);

        vm.expectRevert(IBosphorAdapter.BlobIdMismatch.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        assertFalse(adapter.executed(intentId));
    }

    function test_lzReceive_type1_duplicate_reverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        bytes memory message = _buildType1Message(intentId, BLOB_ID, 42);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        vm.expectRevert(IBosphorAdapter.AlreadyExecuted.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
    }

    function test_lzReceive_type1_nonExistent_reverts() public {
        // A nonexistent intent has a zeroed committed blob id, so a zero blobId proof
        // passes the reference check and then reverts with IntentNotFound.
        bytes32 fakeId = bytes32(uint256(999));
        bytes memory message = _buildType1Message(fakeId, bytes32(0), 1);

        vm.expectRevert(IBosphorAdapter.IntentNotFound.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
    }

    function test_lzReceive_type1_afterDeadline_succeeds() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 intentId = _submit(user, BLOB_ID, deadline);

        vm.warp(deadline + 1);
        bytes memory message = _buildType1Message(intentId, BLOB_ID, 42);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
        assertTrue(adapter.executed(intentId));
    }

    function test_lzReceive_emptyMessage_reverts() public {
        vm.expectRevert(IBosphorAdapter.UnknownMessageType.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, "");
    }

    function test_lzReceive_unknownType_reverts() public {
        bytes memory msgType0 = bytes.concat(bytes1(0x00), abi.encode(bytes32(0), bytes32(0), uint256(0)));
        vm.expectRevert(IBosphorAdapter.UnknownMessageType.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, msgType0);

        bytes memory msgType2 = bytes.concat(bytes1(0x02), abi.encode(bytes32(0), bytes32(0), uint256(0)));
        vm.expectRevert(IBosphorAdapter.UnknownMessageType.selector);
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, msgType2);
    }

    // --- quote ---

    function test_quote_returns_fee() public view {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        MessagingFee memory fee =
            adapter.quote(DST_EID, BLOB_ID, SIZE, ENCODING, EPOCHS, deadline, _defaultOptions());
        assertEq(fee.nativeFee, endpoint.NATIVE_FEE());
        assertEq(fee.lzTokenFee, 0);
    }
}
