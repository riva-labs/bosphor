// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ICctpTokenMessenger } from "./interfaces/ICctpTokenMessenger.sol";

/// @title CctpSettler
/// @author Riva Labs
/// @notice Scaffolding for the CCTP stablecoin settlement rail (deferred live
///         wiring). Burns escrowed USDC on the source domain via the CCTP
///         TokenMessenger so it can be minted on the destination domain after
///         Circle's Iris attestation. Kept behind {ICctpTokenMessenger} so tests
///         inject a mock and the live deployment injects the real messenger.
/// @dev Not wired into the native payment path. This exists so the USDC rail is
///      structured and testable now; the end-to-end burn+attest+mint flow is a
///      fast-follow. See the M4 issue for the deferred live-wiring checklist.
contract CctpSettler {
    using SafeERC20 for IERC20;

    /// @notice The CCTP TokenMessenger this settler burns through.
    ICctpTokenMessenger public immutable messenger;
    /// @notice The USDC token burned for settlement.
    IERC20 public immutable usdc;

    event SettlementBurned(uint64 indexed nonce, uint256 amount, uint32 destinationDomain, bytes32 mintRecipient);

    error ZeroAddress();

    constructor(address _messenger, address _usdc) {
        if (_messenger == address(0) || _usdc == address(0)) revert ZeroAddress();
        messenger = ICctpTokenMessenger(_messenger);
        usdc = IERC20(_usdc);
    }

    /// @notice Burn `amount` USDC for minting to `mintRecipient` on
    ///         `destinationDomain`. Approves the messenger and calls depositForBurn.
    /// @dev The caller must have transferred/approved `amount` of USDC to this
    ///      contract. Returns the CCTP nonce the relayer uses to fetch the Iris
    ///      attestation off-chain.
    function settle(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient
    ) external returns (uint64 nonce) {
        usdc.forceApprove(address(messenger), amount);
        nonce = messenger.depositForBurn(amount, destinationDomain, mintRecipient, address(usdc));
        emit SettlementBurned(nonce, amount, destinationDomain, mintRecipient);
    }
}
