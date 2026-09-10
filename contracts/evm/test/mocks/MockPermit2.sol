// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ISignatureTransfer } from "../../src/interfaces/ISignatureTransfer.sol";

/// @dev Minimal Permit2 mock: performs the witness transfer by pulling tokens via
///      the standard ERC20 allowance (the test approves this mock), and records the
///      witness so a test can assert the deposit was bound to the intent id. It does
///      NOT verify the signature; signature validity is Permit2's job on-chain and is
///      out of scope for these unit tests.
contract MockPermit2 is ISignatureTransfer {
    bytes32 public lastWitness;
    address public lastOwner;
    string public lastWitnessTypeString;

    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata /*signature*/
    ) external {
        lastWitness = witness;
        lastOwner = owner;
        lastWitnessTypeString = witnessTypeString;
        require(
            transferDetails.requestedAmount <= permit.permitted.amount,
            "requested exceeds permitted"
        );
        IERC20(permit.permitted.token).transferFrom(
            owner,
            transferDetails.to,
            transferDetails.requestedAmount
        );
    }
}
