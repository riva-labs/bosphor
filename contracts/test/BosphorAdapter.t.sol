// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BosphorAdapter.sol";

contract BosphorAdapterTest is Test {
    BosphorAdapter adapter;
    address relayer = address(0xBEEF);
    address user = address(0xCAFE);
    address attacker = address(0xDEAD);

    function setUp() public {
        adapter = new BosphorAdapter(relayer);
    }

    // --- submitIntent ---

    function test_submitIntent_success() public {
        vm.prank(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = adapter.submitIntent(1, "hello", deadline);

        assertTrue(adapter.intents(intentId));
        assertEq(adapter.intentDeadlines(intentId), deadline);
        assertEq(adapter.nonces(user), 1);
    }

    function test_submitIntent_expiredDeadline_reverts() public {
        vm.prank(user);
        vm.expectRevert(BosphorAdapter.DeadlineExpired.selector);
        adapter.submitIntent(1, "hello", block.timestamp - 1);
    }

    function test_submitIntent_incrementsNonce() public {
        vm.startPrank(user);
        uint256 deadline = block.timestamp + 1 hours;
        adapter.submitIntent(1, "a", deadline);
        adapter.submitIntent(1, "b", deadline);
        vm.stopPrank();

        assertEq(adapter.nonces(user), 2);
    }

    function test_submitIntent_uniqueIds() public {
        vm.startPrank(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 id1 = adapter.submitIntent(1, "a", deadline);
        bytes32 id2 = adapter.submitIntent(1, "a", deadline); // same payload, different nonce
        vm.stopPrank();

        assertTrue(id1 != id2);
    }

    // --- confirmExecution ---

    function test_confirmExecution_success() public {
        vm.prank(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = adapter.submitIntent(1, "hello", deadline);

        vm.prank(relayer);
        adapter.confirmExecution(intentId, "proof");

        assertTrue(adapter.executed(intentId));
    }

    function test_confirmExecution_unauthorizedCaller_reverts() public {
        vm.prank(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = adapter.submitIntent(1, "hello", deadline);

        vm.prank(attacker);
        vm.expectRevert(BosphorAdapter.OnlyRelayer.selector);
        adapter.confirmExecution(intentId, "proof");
    }

    function test_confirmExecution_replayAttack_reverts() public {
        vm.prank(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = adapter.submitIntent(1, "hello", deadline);

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
        vm.prank(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 intentId = adapter.submitIntent(1, "hello", deadline);

        // Fast forward past deadline
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
        vm.expectRevert(BosphorAdapter.OnlyOwner.selector);
        adapter.setRelayer(attacker);
    }

    function test_setRelayer_zeroAddress_reverts() public {
        vm.expectRevert(BosphorAdapter.ZeroAddress.selector);
        adapter.setRelayer(address(0));
    }

    function test_constructor_zeroRelayer_reverts() public {
        vm.expectRevert(BosphorAdapter.ZeroAddress.selector);
        new BosphorAdapter(address(0));
    }

    // --- getIntentId ---

    function test_getIntentId_matches_submitIntent() public {
        vm.prank(user);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 submitted = adapter.submitIntent(1, "hello", deadline);

        bytes32 computed = adapter.getIntentId(user, 1, "hello", 0, deadline);
        assertEq(submitted, computed);
    }
}
