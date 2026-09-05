// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/BosphorEscrowAdapter.sol";
import "../src/EscrowVault.sol";
import "../src/CctpSettler.sol";
import "../src/interfaces/ISignatureTransfer.sol";
import "./mocks/EndpointV2Mock.sol";
import "./mocks/MockERC20.sol";
import "./mocks/MockPermit2.sol";
import "./mocks/MockCctpTokenMessenger.sol";

/// @notice USDC (Permit2 witness) deposit path + CCTP settlement scaffolding.
///         All external pieces are mocked; live testnet wiring is deferred.
contract UsdcCctpTest is Test {
    BosphorEscrowAdapter adapter;
    EndpointV2Mock endpoint;
    MockERC20 usdc;
    MockPermit2 permit2;

    address relayer = address(0xBEEF);
    address user = address(0xCAFE);
    address stranger = address(0x5555);

    bytes32 constant INTENT_ID = bytes32(uint256(0x1111));
    uint256 constant USDC_AMOUNT = 5_000_000; // 5 USDC (6 decimals)

    function setUp() public {
        endpoint = new EndpointV2Mock();
        adapter = new BosphorEscrowAdapter(address(endpoint), address(this), relayer);
        usdc = new MockERC20();
        permit2 = new MockPermit2();
        adapter.setPermit2(address(permit2));

        usdc.mint(user, USDC_AMOUNT);
        // The user approves Permit2 (the real flow signs a permit; the mock pulls
        // via allowance).
        vm.prank(user);
        usdc.approve(address(permit2), type(uint256).max);
    }

    function _permit(uint256 amount) internal view returns (ISignatureTransfer.PermitTransferFrom memory) {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({ token: address(usdc), amount: amount }),
            nonce: 0,
            deadline: block.timestamp + 1 hours
        });
    }

    function test_usdcDeposit_viaPermit2Witness_bindsToIntentId() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.prank(user);
        adapter.depositUsdcWithPermit2(INTENT_ID, deadline, _permit(USDC_AMOUNT), "sig");

        // The witness passed to Permit2 is the intent id: the signature authorized
        // the pull for this intent only.
        assertEq(permit2.lastWitness(), INTENT_ID);
        assertEq(permit2.lastOwner(), user);

        // USDC is escrowed in the adapter, recorded as a token escrow.
        assertEq(usdc.balanceOf(address(adapter)), USDC_AMOUNT);
        EscrowVault.Escrow memory e = adapter.getEscrow(INTENT_ID);
        assertEq(e.payer, user);
        assertEq(e.token, address(usdc));
        assertEq(e.amount, USDC_AMOUNT);
        assertEq(uint8(e.status), uint8(EscrowVault.EscrowStatus.Pending));
    }

    function test_usdcDeposit_revertsWhenPermit2NotConfigured() public {
        BosphorEscrowAdapter bare = new BosphorEscrowAdapter(address(endpoint), address(this), relayer);
        vm.prank(user);
        vm.expectRevert(BosphorEscrowAdapter.Permit2NotConfigured.selector);
        bare.depositUsdcWithPermit2(INTENT_ID, uint64(block.timestamp + 1 hours), _permit(USDC_AMOUNT), "sig");
    }

    function test_usdcEscrow_refundAfterDeadline_paysPayerInUsdc() public {
        uint64 deadline = uint64(block.timestamp + 1 hours);
        vm.prank(user);
        adapter.depositUsdcWithPermit2(INTENT_ID, deadline, _permit(USDC_AMOUNT), "sig");

        vm.warp(deadline + 1);
        vm.prank(stranger); // permissionless
        adapter.refund(INTENT_ID);

        assertEq(adapter.withdrawableToken(address(usdc), user), USDC_AMOUNT);
        vm.prank(user);
        adapter.withdrawToken(address(usdc));
        assertEq(usdc.balanceOf(user), USDC_AMOUNT);
    }

    function test_nativePathRemainsDefault_unaffectedByUsdcOptIn() public {
        // A native submit still works with Permit2 configured: USDC is purely opt-in.
        uint64 deadline = uint64(block.timestamp + 1 hours);
        adapter.setPeer(30378, bytes32(uint256(0x1234)));
        vm.deal(user, 0.05 ether);
        vm.prank(user);
        bytes32 id = adapter.submitIntent{value: 0.05 ether}(
            30378, bytes32(uint256(0xABCDEF)), 1024, 1, 5, deadline,
            hex"0003010011010000000000000000000000000000c350"
        );
        EscrowVault.Escrow memory e = adapter.getEscrow(id);
        assertEq(e.token, address(0)); // native
    }

    // --- CCTP settlement scaffolding ---

    function test_cctpSettler_burnsUsdcAndReturnsNonce() public {
        MockCctpTokenMessenger messenger = new MockCctpTokenMessenger();
        CctpSettler settler = new CctpSettler(address(messenger), address(usdc));

        usdc.mint(address(settler), USDC_AMOUNT);
        bytes32 recipient = bytes32(uint256(uint160(relayer)));
        uint64 nonce = settler.settle(USDC_AMOUNT, 5, recipient); // domain 5 = Solana

        assertEq(nonce, 1);
        assertEq(messenger.lastAmount(), USDC_AMOUNT);
        assertEq(messenger.lastDestinationDomain(), 5);
        assertEq(messenger.lastMintRecipient(), recipient);
        assertEq(usdc.balanceOf(address(messenger)), USDC_AMOUNT); // burned/pulled
    }
}
