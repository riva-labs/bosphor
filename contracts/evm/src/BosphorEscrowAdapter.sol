// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { IBosphorAdapter } from "./interfaces/IBosphorAdapter.sol";
import { CommitmentCodec } from "./CommitmentCodec.sol";
import { EscrowVault } from "./EscrowVault.sol";

/// @title BosphorEscrowAdapter
/// @author Riva Labs
/// @notice M4 adapter: a priced cross-chain storage router that escrows the user
///         payment at submit and releases it to the relayer only on a genuine
///         Sui-originated LayerZero proof.
/// @dev Extends the M3 commitment-routing adapter with DLN-style origin escrow
///      (see {EscrowVault}). At `submitIntent` the caller sends the forward LZ fee
///      plus the escrow amount as one `msg.value`; the contract pays only the LZ
///      fee to the endpoint and escrows the remainder keyed by intent id. Release
///      happens exclusively inside `_lzReceive` after the returned blob id matches
///      the committed one. The owner `confirmExecution` fallback marks the intent
///      executed for observability but never moves escrowed funds, closing the
///      trust gap where an owner call could stand in for a real proof.
contract BosphorEscrowAdapter is OApp, EscrowVault, IBosphorAdapter {
    // --- State ---
    /// @notice Beneficiary credited when an escrow is released on a valid proof.
    address public trustedRelayer;
    mapping(bytes32 => bool) public intents;
    mapping(bytes32 => bool) public executed;
    mapping(bytes32 => bytes32) public committedBlobId;
    mapping(bytes32 => uint256) public intentDeadlines;
    mapping(address => uint256) public nonces;

    // --- Errors ---
    /// @notice Thrown when msg.value does not cover the LayerZero messaging fee.
    error InsufficientPayment();

    // --- Constructor ---
    /// @param _endpoint Address of the LayerZero EndpointV2 on this chain.
    /// @param _delegate Address granted administrative rights over the OApp config.
    /// @param _trustedRelayer Beneficiary credited on release. Must not be zero.
    constructor(
        address _endpoint,
        address _delegate,
        address _trustedRelayer
    ) OApp(_endpoint, _delegate) {
        if (_trustedRelayer == address(0)) revert ZeroAddress();
        trustedRelayer = _trustedRelayer;
    }

    // --- Core ---
    /// @inheritdoc IBosphorAdapter
    /// @dev `msg.value` must be at least the LayerZero fee; the surplus is escrowed
    ///      as the priced payment for this intent, keyed by intent id.
    function submitIntent(
        uint32 _dstEid,
        bytes32 _blobId,
        uint32 _size,
        uint8 _encodingType,
        uint32 _storageEpochs,
        uint64 _deadline,
        bytes calldata _options
    ) external payable returns (bytes32 intentId) {
        if (block.timestamp > _deadline) revert DeadlineExpired();

        uint256 nonce = nonces[msg.sender]++;

        CommitmentCodec.Commitment memory c =
            CommitmentCodec.Commitment(_blobId, _size, _encodingType, _storageEpochs, _deadline);

        intentId = CommitmentCodec.deriveIntentId(c, bytes32(uint256(uint160(msg.sender))), uint64(nonce));

        if (intents[intentId]) revert IntentAlreadyExists();
        intents[intentId] = true;
        committedBlobId[intentId] = _blobId;
        intentDeadlines[intentId] = _deadline;

        // Split msg.value (LZ fee to endpoint, surplus escrowed) in a helper to
        // keep this frame's local count under the stack-depth limit.
        _escrowAndSend(_dstEid, intentId, c, _options, _deadline);

        emit IntentSubmitted(
            intentId, msg.sender, uint64(_dstEid), _blobId, _size, _encodingType, _storageEpochs, uint64(nonce), _deadline
        );
    }

    /// @dev Quote the LZ fee, escrow the surplus of msg.value, and send the message.
    function _escrowAndSend(
        uint32 _dstEid,
        bytes32 _intentId,
        CommitmentCodec.Commitment memory _c,
        bytes calldata _options,
        uint64 _deadline
    ) private {
        bytes memory message = abi.encodePacked(_intentId, CommitmentCodec.encode(_c));
        MessagingFee memory fee = _quote(_dstEid, message, _options, false);
        if (msg.value < fee.nativeFee) revert InsufficientPayment();
        _openNativeEscrow(_intentId, msg.sender, msg.value - fee.nativeFee, _deadline);
        _lzSend(_dstEid, message, _options, fee, msg.sender);
    }

    /// @dev Allow `msg.value` to exceed the LZ fee: the surplus is the escrow the
    ///      contract retains. Only the fee is forwarded to the endpoint. Without
    ///      this override OAppSender would revert on `msg.value != nativeFee`.
    function _payNative(uint256 _nativeFee) internal view override returns (uint256) {
        if (msg.value < _nativeFee) revert InsufficientPayment();
        return _nativeFee;
    }

    // --- LayerZero Receive (proof from Sui) ---
    /// @dev Type 1 message: `(bytes32 intentId, bytes32 blobId, uint256 endEpoch)`.
    ///      The blob id is checked against the committed one; on match the intent is
    ///      marked executed AND the escrow is released to the relayer beneficiary.
    ///      This is the ONLY path that moves escrowed funds.
    function _lzReceive(
        Origin calldata, /*_origin*/
        bytes32, /*_guid*/
        bytes calldata _message,
        address, /*_executor*/
        bytes calldata /*_extraData*/
    ) internal override {
        if (_message.length == 0) revert UnknownMessageType();
        uint8 msgType = uint8(_message[0]);
        if (msgType == 1) {
            (bytes32 intentId, bytes32 blobId, uint256 endEpoch) =
                abi.decode(_message[1:], (bytes32, bytes32, uint256));
            if (blobId != committedBlobId[intentId]) revert BlobIdMismatch();
            _markExecuted(intentId, abi.encode(blobId, endEpoch));
            _releaseEscrow(intentId, trustedRelayer);
        } else {
            revert UnknownMessageType();
        }
    }

    // --- Refund ---
    /// @notice Permissionlessly refund an intent's escrow to its payer after the deadline.
    /// @dev Anyone may trigger it; funds only ever go to the recorded payer.
    function refund(bytes32 _intentId) external {
        _refundEscrow(_intentId);
    }

    // --- Owner fallback (observability only, NON-releasing) ---
    /// @inheritdoc IBosphorAdapter
    /// @dev Marks the intent executed for observability. It deliberately does NOT
    ///      release escrow: only a genuine proof via `_lzReceive` can move funds.
    function confirmExecution(bytes32 _intentId, bytes calldata _proof) external onlyOwner {
        _markExecuted(_intentId, _proof);
    }

    /// @dev Shared execution bookkeeping (no fund movement).
    function _markExecuted(bytes32 _intentId, bytes memory _proof) internal {
        if (!intents[_intentId]) revert IntentNotFound();
        if (executed[_intentId]) revert AlreadyExecuted();
        executed[_intentId] = true;
        emit IntentExecuted(_intentId, _proof);
    }

    // --- Fee estimation ---
    /// @inheritdoc IBosphorAdapter
    function quote(
        uint32 _dstEid,
        bytes32 _blobId,
        uint32 _size,
        uint8 _encodingType,
        uint32 _storageEpochs,
        uint64 _deadline,
        bytes calldata _options
    ) external view returns (MessagingFee memory fee) {
        CommitmentCodec.Commitment memory c =
            CommitmentCodec.Commitment(_blobId, _size, _encodingType, _storageEpochs, _deadline);
        bytes memory message = abi.encodePacked(bytes32(0), CommitmentCodec.encode(c));
        return _quote(_dstEid, message, _options, false);
    }

    // --- Admin ---
    /// @inheritdoc IBosphorAdapter
    function setRelayer(address _relayer) external onlyOwner {
        if (_relayer == address(0)) revert ZeroAddress();
        address old = trustedRelayer;
        trustedRelayer = _relayer;
        emit RelayerUpdated(old, _relayer);
    }

    // --- View ---
    /// @inheritdoc IBosphorAdapter
    function getIntentId(
        address _sender,
        bytes32 _blobId,
        uint32 _size,
        uint8 _encodingType,
        uint32 _storageEpochs,
        uint64 _deadline,
        uint64 _nonce
    ) external pure returns (bytes32) {
        return CommitmentCodec.deriveIntentId(
            CommitmentCodec.Commitment(_blobId, _size, _encodingType, _storageEpochs, _deadline),
            bytes32(uint256(uint160(_sender))),
            _nonce
        );
    }
}
