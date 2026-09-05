// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ICctpTokenMessenger
/// @notice Minimal Circle CCTP v2 TokenMessenger surface for the stablecoin
///         settlement rail (scaffolding; live wiring deferred).
/// @dev The real messenger burns USDC on the source domain and emits a message
///      that Circle's Iris service attests; the relayer then mints on the
///      destination domain. Only `depositForBurn` is declared here.
interface ICctpTokenMessenger {
    /// @notice Burn `amount` of `burnToken` for minting to `mintRecipient` on
    ///         `destinationDomain`. Returns the CCTP message nonce.
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}
