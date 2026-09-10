// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BosphorEscrowAdapter.sol";
import "../src/CommitmentCodec.sol";
import "./mocks/EndpointV2Mock.sol";

/// @title BosphorEscrowGas
/// @notice Gas-simulation suite for the EVM payment path (deliverable c).
/// @dev Each test performs one operation so `forge test --gas-report` documents
///      per-operation gas, and a cost-per-blob-size curve (submit gas is flat in
///      the blob size because only the u32 size field changes on-chain; the blob
///      bytes never touch the chain). Run: forge test --match-contract
///      BosphorEscrowGas --gas-report
contract BosphorEscrowGasTest is Test {
    BosphorEscrowAdapter adapter;
    EndpointV2Mock endpoint;

    address relayer = address(0xBEEF);
    address user = address(0xCAFE);

    uint32 constant DST_EID = 30378;
    uint32 constant SRC_EID = 40378;
    bytes32 constant PEER = bytes32(uint256(0x1234));
    bytes32 constant BLOB_ID = bytes32(uint256(0xABCDEF));
    uint8 constant ENCODING = 1;
    uint32 constant EPOCHS = 5;
    uint256 constant FEE = 0.001 ether;
    uint256 constant ESCROW = 0.05 ether;

    function setUp() public {
        endpoint = new EndpointV2Mock();
        adapter = new BosphorEscrowAdapter(address(endpoint), address(this), relayer);
        adapter.setPeer(DST_EID, PEER);
        adapter.setPeer(SRC_EID, PEER);
    }

    function _options() internal pure returns (bytes memory) {
        return hex"0003010011010000000000000000000000000000c350";
    }

    function _submit(uint32 size) internal returns (bytes32) {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.deal(user, FEE + ESCROW);
        vm.prank(user);
        return adapter.submitIntent{value: FEE + ESCROW}(
            DST_EID, BLOB_ID, size, ENCODING, EPOCHS, deadline, _options()
        );
    }

    function _proof(bytes32 intentId) internal {
        bytes memory msg1 = bytes.concat(bytes1(0x01), abi.encode(intentId, BLOB_ID, uint256(42)));
        endpoint.simulateLzReceive(address(adapter), SRC_EID, PEER, msg1);
    }

    // --- Cost-per-blob-size curve: submit gas at representative sizes ---

    function test_gas_submit_1KiB() public {
        _submit(1024);
    }

    function test_gas_submit_1MiB() public {
        _submit(1024 * 1024);
    }

    function test_gas_submit_10MiB() public {
        _submit(10 * 1024 * 1024);
    }

    // --- Per-operation gas for the payment lifecycle ---

    function test_gas_release_onProof() public {
        bytes32 id = _submit(1024 * 1024);
        _proof(id);
    }

    function test_gas_withdraw() public {
        bytes32 id = _submit(1024 * 1024);
        _proof(id);
        vm.prank(relayer);
        adapter.withdraw();
    }

    function test_gas_refund_afterDeadline() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.deal(user, FEE + ESCROW);
        vm.prank(user);
        bytes32 id = adapter.submitIntent{value: FEE + ESCROW}(
            DST_EID, BLOB_ID, 1024 * 1024, ENCODING, EPOCHS, deadline, _options()
        );
        vm.warp(deadline + 1);
        adapter.refund(id);
    }

    /// @notice Fee abstraction: one msg.value covers the LZ fee and the escrow,
    ///         and only the fee reaches the endpoint (the rest stays escrowed).
    function test_feeAbstraction_singlePaymentCoversStack() public {
        bytes32 id = _submit(1024 * 1024);
        assertEq(endpoint.lastSendValue(), FEE);
        assertEq(adapter.getEscrow(id).amount, ESCROW);
        assertEq(address(adapter).balance, ESCROW);
    }
}
