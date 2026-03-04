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

    // --- confirmExecution (hybrid relayer path) ---

    function test_confirmExecution_success() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.prank(relayer);
        adapter.confirmExecution(intentId, "proof");

        assertTrue(adapter.executed(intentId));
    }

    function test_confirmExecution_unauthorizedCaller_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.prank(attacker);
        vm.expectRevert(BosphorAdapter.OnlyRelayer.selector);
        adapter.confirmExecution(intentId, "proof");
    }

    function test_confirmExecution_replayAttack_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.startPrank(relayer);
        adapter.confirmExecution(intentId, "proof");

        vm.expectRevert(BosphorAdapter.AlreadyExecuted.selector);
        adapter.confirmExecution(intentId, "proof");
        vm.stopPrank();
    }

    function test_confirmExecution_nonExistentIntent_reverts() public {
        vm.prank(relayer);
        vm.expectRevert(BosphorAdapter.IntentNotFound.selector);
        adapter.confirmExecution(bytes32(uint256(999)), "proof");
    }

    function test_confirmExecution_expiredDeadline_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        vm.warp(deadline + 1);

        vm.prank(relayer);
        vm.expectRevert(BosphorAdapter.DeadlineExpired.selector);
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

    // --- LayerZero receive (proof via LZ) ---

    function test_lzReceive_marks_executed() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        // Simulate LZ message with proof
        bytes memory proof = abi.encodePacked("lz-proof-data");
        bytes memory message = abi.encode(intentId, proof);

        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        assertTrue(adapter.executed(intentId));
    }

    function test_lzReceive_replayAttack_reverts() public {
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = _submitIntent(user, "hello", deadline);

        bytes memory proof = abi.encodePacked("lz-proof");
        bytes memory message = abi.encode(intentId, proof);

        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);

        // Second attempt should revert
        vm.expectRevert();
        endpoint.simulateLzReceive(address(adapter), DST_EID, PEER, message);
    }

    // --- quote ---

    function test_quote_returns_fee() public view {
        uint256 deadline = block.timestamp + 1 hours;
        MessagingFee memory fee = adapter.quote(DST_EID, "hello", deadline, _defaultOptions());
        assertEq(fee.nativeFee, endpoint.NATIVE_FEE());
        assertEq(fee.lzTokenFee, 0);
    }
}
