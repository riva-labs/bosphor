// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MessagingParams, MessagingFee, MessagingReceipt, Origin } from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";

/// @dev Minimal mock for LayerZero EndpointV2 — enough to test OApp send/receive flows.
contract EndpointV2Mock {
    uint256 public constant NATIVE_FEE = 0.001 ether;
    uint64 public nonce;

    // Tracks delegate per OApp
    mapping(address => address) public delegates;

    function setDelegate(address _delegate) external {
        delegates[msg.sender] = _delegate;
    }

    function quote(
        MessagingParams calldata /*_params*/,
        address /*_sender*/
    ) external pure returns (MessagingFee memory) {
        return MessagingFee(NATIVE_FEE, 0);
    }

    function send(
        MessagingParams calldata /*_params*/,
        address /*_refundAddress*/
    ) external payable returns (MessagingReceipt memory) {
        nonce++;
        return MessagingReceipt(
            keccak256(abi.encodePacked(nonce, block.timestamp)),
            nonce,
            MessagingFee(msg.value, 0)
        );
    }

    function lzToken() external pure returns (address) {
        return address(0);
    }

    function nativeToken() external pure returns (address) {
        return address(0);
    }

    /// @dev Helper to simulate receiving a LZ message on the target OApp.
    function simulateLzReceive(
        address _oapp,
        uint32 _srcEid,
        bytes32 _sender,
        bytes calldata _message
    ) external {
        nonce++;
        Origin memory origin = Origin(_srcEid, _sender, nonce);
        bytes32 guid = keccak256(abi.encodePacked(nonce, _srcEid, _sender));

        // Call lzReceive on the OApp as the endpoint
        (bool success, bytes memory reason) = _oapp.call(
            abi.encodeWithSignature(
                "lzReceive((uint32,bytes32,uint64),bytes32,bytes,address,bytes)",
                origin,
                guid,
                _message,
                address(0),
                ""
            )
        );
        if (!success) {
            assembly {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}
