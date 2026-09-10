// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISignatureTransfer
/// @notice Minimal Permit2 SignatureTransfer surface used by the USDC escrow path.
/// @dev Matches Uniswap's canonical Permit2 at
///      0x000000000022D473030F116dDEE9F6B43aC78BA3 (same on every chain). Only the
///      witness-transfer entrypoint the escrow needs is declared here; the live
///      wiring points this at the real Permit2, tests point it at a mock.
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    /// @notice Transfer tokens using a permit signed over a caller-supplied witness.
    /// @dev The witness (here the intent id) is folded into the signed digest, so the
    ///      user's signature authorizes the pull ONLY for that specific intent.
    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}
