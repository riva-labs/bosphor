// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ICctpTokenMessenger } from "../../src/interfaces/ICctpTokenMessenger.sol";

/// @dev Minimal CCTP TokenMessenger mock: pulls the burn amount via allowance
///      (simulating the burn) and returns an incrementing nonce. Records the last
///      call so a test can assert the settlement parameters.
contract MockCctpTokenMessenger is ICctpTokenMessenger {
    uint64 public nonce;
    uint256 public lastAmount;
    uint32 public lastDestinationDomain;
    bytes32 public lastMintRecipient;
    address public lastBurnToken;

    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64) {
        // Simulate the burn by pulling the tokens from the caller.
        IERC20(burnToken).transferFrom(msg.sender, address(this), amount);
        lastAmount = amount;
        lastDestinationDomain = destinationDomain;
        lastMintRecipient = mintRecipient;
        lastBurnToken = burnToken;
        return ++nonce;
    }
}
