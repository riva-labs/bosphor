// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";
import { IBosphorAdapter } from "./interfaces/IBosphorAdapter.sol";
import { CommitmentCodec } from "./CommitmentCodec.sol";

/// @title BosphorAdapter
/// @author Riva Labs
/// @notice LayerZero v2 OApp that routes storage intents from EVM to Sui/Walrus and
///         receives execution proofs back, enabling cross-chain decentralised storage.
/// @dev Intents flow EVM -> LayerZero v2 -> Sui lz_receive -> Walrus upload -> proof
///      back to this contract via either a LayerZero message or a trusted relayer call.
///      Milestone 3 replaces the arbitrary payload with a compact storage commitment
///      that references a Walrus blob by id. The forward message carries only the intent
///      id and the encoded commitment, never the raw blob contents. The returned proof is
///      checked against the committed blob id before the intent is marked executed.
contract BosphorAdapter is OApp, IBosphorAdapter {
    // --- State ---
    address public trustedRelayer;
    mapping(bytes32 => bool) public intents;
    mapping(bytes32 => bool) public executed;
    mapping(bytes32 => bytes32) public committedBlobId;
    mapping(bytes32 => uint256) public intentDeadlines;
    mapping(address => uint256) public nonces;

    // --- Constructor ---
    /// @notice Deploys the adapter and registers it with the LayerZero endpoint.
    /// @dev The delegate is forwarded to OApp and becomes the LayerZero config admin.
    /// @param _endpoint Address of the LayerZero EndpointV2 on this chain.
    /// @param _delegate Address granted administrative rights over the OApp config.
    /// @param _trustedRelayer Address of the trusted relayer for off-chain identification. Must not be zero.
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

        intentId = CommitmentCodec.deriveIntentId(
            c,
            bytes32(uint256(uint160(msg.sender))),
            uint64(nonce)
        );

        if (intents[intentId]) revert IntentAlreadyExists();
        intents[intentId] = true;
        committedBlobId[intentId] = _blobId;
        intentDeadlines[intentId] = _deadline;

        // The forward message carries only the intent id and the encoded commitment,
        // 32 + 50 = 82 bytes. No raw blob contents are placed on the wire.
        bytes memory message = abi.encodePacked(intentId, CommitmentCodec.encode(c));
        _lzSend(_dstEid, message, _options, MessagingFee(msg.value, 0), msg.sender);

        emit IntentSubmitted(
            intentId,
            msg.sender,
            uint64(_dstEid),
            _blobId,
            _size,
            _encodingType,
            _storageEpochs,
            uint64(nonce),
            _deadline
        );
    }

    // --- LayerZero Receive (proof from remote chain) ---
    /// @notice Handles incoming LayerZero messages from the remote chain.
    /// @dev The first byte is a message type discriminator:
    ///      - Type 1: Execution proof from Sui. Remaining bytes are ABI-encoded as
    ///        `(bytes32 intentId, bytes32 blobId, uint256 endEpoch)`. The returned blob id
    ///        is checked against the blob id committed at submission time; a mismatch reverts
    ///        with `BlobIdMismatch`. On success the intent is marked executed and
    ///        `IntentExecuted` is emitted with the proof.
    ///      - All other types revert with `UnknownMessageType`.
    function _lzReceive(
        Origin calldata /*_origin*/,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override {
        if (_message.length == 0) revert UnknownMessageType();
        uint8 msgType = uint8(_message[0]);
        if (msgType == 1) {
            (bytes32 intentId, bytes32 blobId, uint256 endEpoch) =
                abi.decode(_message[1:], (bytes32, bytes32, uint256));
            if (blobId != committedBlobId[intentId]) revert BlobIdMismatch();
            _markExecuted(intentId, abi.encode(blobId, endEpoch));
        } else {
            revert UnknownMessageType();
        }
    }

    // --- Hybrid relayer path (backward-compatible) ---
    /// @inheritdoc IBosphorAdapter
    function confirmExecution(
        bytes32 _intentId,
        bytes calldata _proof
    ) external onlyOwner {
        _markExecuted(_intentId, _proof);
    }

    // --- Internal execution logic ---
    /// @notice Shared validation and state update for both execution paths.
    /// @dev Reverts if the intent does not exist or was already executed.
    ///      Deadline is enforced only at submission time (`submitIntent`), not at proof
    ///      receipt, because the storage has already been completed on Walrus by the time
    ///      the proof arrives.
    /// @param _intentId The deterministic identifier of the intent.
    /// @param _proof Opaque proof data to emit alongside the execution event.
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
        // Same 81-byte shape as submitIntent, with a zeroed intent id placeholder.
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
