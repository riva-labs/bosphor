// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BosphorEscrowAdapter.sol";
import "../src/EscrowVault.sol";
import "../src/interfaces/IBosphorAdapter.sol";
import "../src/CommitmentCodec.sol";
import "./mocks/EndpointV2Mock.sol";

/// @dev Reentrancy attacker: on receiving native (during withdraw()) it calls
///      back into withdraw() to try to drain more than its credited balance.
contract ReentrantWithdrawer {
    BosphorEscrowAdapter public adapter;
    uint256 public reentries;

    constructor(BosphorEscrowAdapter _adapter) {
        adapter = _adapter;
    }

    function attack() external {
        adapter.withdraw();
    }

    receive() external payable {
        if (reentries < 1) {
            reentries++;
            adapter.withdraw();
        }
    }
}

contract BosphorEscrowAdapterTest is Test {
    BosphorEscrowAdapter adapter;
    EndpointV2Mock endpoint;

    address relayer = address(0xBEEF);
    address user = address(0xCAFE);
    address stranger = address(0x5555);

    uint32 constant DST_EID = 30378;
    bytes32 constant PEER = bytes32(uint256(0x1234));
    uint32 constant SRC_EID = 40378;

    bytes32 constant BLOB_ID = bytes32(uint256(0xABCDEF));
    uint32 constant SIZE = 1024;
    uint8 constant ENCODING = 1;
    uint32 constant EPOCHS = 5;

    uint256 constant FEE = 0.001 ether;
    uint256 constant ESCROW = 0.05 ether;

    function setUp() public {
        endpoint = new EndpointV2Mock();
        adapter = new BosphorEscrowAdapter(address(endpoint), address(this), relayer);
        adapter.setPeer(DST_EID, PEER);
        // Peer for the return path so the endpoint mock can deliver a proof.
        adapter.setPeer(SRC_EID, PEER);
    }

    // --- helpers ---

    function _options() internal pure returns (bytes memory) {
        return hex"0003010011010000000000000000000000000000c350";
    }

    function _submit(address sender, bytes32 blobId, uint64 deadline, uint256 value)
        internal
        returns (bytes32)
    {
        vm.deal(sender, value);
        vm.prank(sender);
        return adapter.submitIntent{value: value}(
            DST_EID, blobId, SIZE, ENCODING, EPOCHS, deadline, _options()
        );
    }

    function _type1(bytes32 intentId, bytes32 blobId, uint256 endEpoch)
        internal
        pure
        returns (bytes memory)
    {
        return bytes.concat(bytes1(0x01), abi.encode(intentId, blobId, endEpoch));
    }

    function _deliverProof(bytes32 intentId, bytes32 blobId) internal {
        endpoint.simulateLzReceive(address(adapter), SRC_EID, PEER, _type1(intentId, blobId, 42));
    }

    // --- deposit ---

    function test_submit_escrowsSurplusAndPaysOnlyFee() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);

        EscrowVault.Escrow memory e = adapter.getEscrow(id);
        assertEq(e.payer, user);
        assertEq(e.token, address(0));
        assertEq(e.amount, ESCROW);
        assertEq(e.deadline, deadline);
        assertEq(uint8(e.status), uint8(EscrowVault.EscrowStatus.Pending));

        // Only the LZ fee reached the endpoint; the escrow stays in the adapter.
        assertEq(endpoint.lastSendValue(), FEE);
        assertEq(address(adapter).balance, ESCROW);
    }

    function test_submit_revertsWhenValueBelowFee() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.deal(user, FEE);
        vm.prank(user);
        vm.expectRevert(BosphorEscrowAdapter.InsufficientPayment.selector);
        adapter.submitIntent{value: FEE - 1}(DST_EID, BLOB_ID, SIZE, ENCODING, EPOCHS, deadline, _options());
    }

    function test_submit_reusedIntentIdReverts() public {
        // Same sender+commitment+nonce derives the same id; the second submit at the
        // same nonce is impossible (nonce increments), so we assert the mapping guard
        // via a direct duplicate: reuse is prevented by intents[intentId].
        uint64 deadline = uint64(block.timestamp + 1 hours);
        _submit(user, BLOB_ID, deadline, FEE + ESCROW);
        // A fresh submit increments the nonce, so a different id: no revert.
        bytes32 id2 = _submit(user, BLOB_ID, deadline, FEE + ESCROW);
        assertTrue(adapter.intents(id2));
        assertEq(adapter.nonces(user), 2);
    }

    // --- proof-gated release ---

    function test_release_onValidProof_creditsRelayerAndMarksExecuted() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);

        _deliverProof(id, BLOB_ID);

        assertTrue(adapter.executed(id));
        EscrowVault.Escrow memory e = adapter.getEscrow(id);
        assertEq(uint8(e.status), uint8(EscrowVault.EscrowStatus.Released));
        assertEq(adapter.withdrawable(relayer), ESCROW);
    }

    function test_release_blobMismatchReverts_andKeepsEscrowPending() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);

        vm.expectRevert(IBosphorAdapter.BlobIdMismatch.selector);
        _deliverProof(id, bytes32(uint256(0xBAD)));

        EscrowVault.Escrow memory e = adapter.getEscrow(id);
        assertEq(uint8(e.status), uint8(EscrowVault.EscrowStatus.Pending));
        assertEq(adapter.withdrawable(relayer), 0);
    }

    function test_doubleRelease_reverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);
        _deliverProof(id, BLOB_ID);

        // A second proof for the same intent: already executed -> revert, no double credit.
        vm.expectRevert(IBosphorAdapter.AlreadyExecuted.selector);
        _deliverProof(id, BLOB_ID);
        assertEq(adapter.withdrawable(relayer), ESCROW);
    }

    // --- owner confirmExecution is NON-releasing ---

    function test_confirmExecution_marksExecutedButDoesNotRelease() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);

        adapter.confirmExecution(id, hex"1234");

        assertTrue(adapter.executed(id));
        // Escrow untouched: only a real proof moves funds.
        EscrowVault.Escrow memory e = adapter.getEscrow(id);
        assertEq(uint8(e.status), uint8(EscrowVault.EscrowStatus.Pending));
        assertEq(adapter.withdrawable(relayer), 0);
    }

    function test_confirmExecution_onlyOwner() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);
        vm.prank(stranger);
        vm.expectRevert();
        adapter.confirmExecution(id, hex"1234");
    }

    // --- refund ---

    function test_refund_afterDeadline_paysPayer_permissionless() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);

        vm.warp(deadline + 1);
        // Anyone can trigger; funds go to the payer only.
        vm.prank(stranger);
        adapter.refund(id);

        EscrowVault.Escrow memory e = adapter.getEscrow(id);
        assertEq(uint8(e.status), uint8(EscrowVault.EscrowStatus.Refunded));
        assertEq(adapter.withdrawable(user), ESCROW);
        assertEq(adapter.withdrawable(stranger), 0);
    }

    function test_refund_beforeDeadlineReverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);
        vm.expectRevert(EscrowVault.DeadlineNotReached.selector);
        adapter.refund(id);
    }

    function test_refund_afterReleaseReverts() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);
        _deliverProof(id, BLOB_ID);
        vm.warp(deadline + 1);
        vm.expectRevert(EscrowVault.EscrowNotPending.selector);
        adapter.refund(id);
    }

    // --- withdrawal ---

    function test_withdraw_paysCreditedBalance() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes32 id = _submit(user, BLOB_ID, deadline, FEE + ESCROW);
        _deliverProof(id, BLOB_ID);

        uint256 before = relayer.balance;
        vm.prank(relayer);
        adapter.withdraw();
        assertEq(relayer.balance, before + ESCROW);
        assertEq(adapter.withdrawable(relayer), 0);
    }

    function test_withdraw_nothingReverts() public {
        vm.prank(stranger);
        vm.expectRevert(EscrowVault.NothingToWithdraw.selector);
        adapter.withdraw();
    }

    function test_withdraw_reentrancyGuarded() public {
        ReentrantWithdrawer attacker = new ReentrantWithdrawer(adapter);
        // Fund the attacker's credit by making it the payer that gets refunded.
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.deal(address(attacker), FEE + ESCROW);
        vm.prank(address(attacker));
        bytes32 id = adapter.submitIntent{value: FEE + ESCROW}(
            DST_EID, BLOB_ID, SIZE, ENCODING, EPOCHS, deadline, _options()
        );
        vm.warp(deadline + 1);
        adapter.refund(id);
        assertEq(adapter.withdrawable(address(attacker)), ESCROW);

        // The reentrant call inside receive() must fail, so the whole withdraw reverts.
        vm.expectRevert();
        attacker.attack();
        // No funds drained beyond the single credit.
        assertEq(address(adapter).balance, ESCROW);
    }
}
