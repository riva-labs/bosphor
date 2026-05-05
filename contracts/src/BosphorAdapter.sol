// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

/// @title BosphorAdapter
/// @author Riva Labs
/// @notice LayerZero v2 OApp that routes storage intents from EVM to Sui/Walrus and
///         receives execution proofs back, enabling cross-chain decentralised storage.
/// @dev Intents flow EVM -> LayerZero v2 -> Sui lz_receive -> Walrus upload -> proof
///      back to this contract via either a LayerZero message or a trusted relayer call.
contract BosphorAdapter is OApp {
    // --- Types ---
    /// @dev Internal representation of a storage intent (not used in external ABI).
    struct Intent {
        address sender;
        uint64 targetChainId;
        bytes payload;
        uint256 nonce;
        uint256 deadline;
    }

    // --- Events ---
    /// @notice Emitted when a new storage intent is submitted and sent cross-chain.
    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed sender,
        uint64 targetChainId,
        bytes payload,
        uint256 nonce,
        uint256 deadline
    );

    /// @notice Emitted when an intent is marked as executed with its proof.
    event IntentExecuted(bytes32 indexed intentId, bytes proof);

    /// @notice Emitted when the owner changes the trusted relayer address.
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    // --- State ---
    address public trustedRelayer;
    mapping(bytes32 => bool) public intents;
    mapping(bytes32 => bool) public executed;
    mapping(bytes32 => uint256) public intentDeadlines;
    mapping(address => uint256) public nonces;

    // --- Errors ---
    error DeadlineExpired();
    error IntentAlreadyExists();
    error IntentNotFound();
    error AlreadyExecuted();
    error OnlyRelayer();
    error ZeroAddress();

    // --- Modifiers ---
    modifier onlyRelayer() {
        if (msg.sender != trustedRelayer) revert OnlyRelayer();
        _;
    }

    // --- Constructor ---
    /// @notice Deploys the adapter and registers it with the LayerZero endpoint.
    /// @dev The delegate is forwarded to OApp and becomes the LayerZero config admin.
    /// @param _endpoint Address of the LayerZero EndpointV2 on this chain.
    /// @param _delegate Address granted administrative rights over the OApp config.
    /// @param _trustedRelayer Address authorised to call `confirmExecution`. Must not be zero.
    constructor(
        address _endpoint,
        address _delegate,
        address _trustedRelayer
    ) OApp(_endpoint, _delegate) {
        if (_trustedRelayer == address(0)) revert ZeroAddress();
        trustedRelayer = _trustedRelayer;
    }

    // --- Core ---
    /// @notice Submits a storage intent and sends it to the destination chain via LayerZero.
    /// @dev The cross-chain message is ABI-encoded as `(intentId, sender, payload, deadline)`.
    ///      The caller must attach enough native gas to cover the LayerZero messaging fee
    ///      (use `quote` to estimate). The intent ID is deterministically derived from the
    ///      sender, destination EID, payload, nonce, and deadline.
    /// @param _dstEid LayerZero endpoint ID of the destination chain (e.g. 40378 for Sui testnet).
    /// @param _payload Arbitrary data describing the storage intent (passed through to Sui).
    /// @param _deadline Unix timestamp after which the intent cannot be executed.
    /// @param _options LayerZero messaging options (gas, executor settings, etc.).
    /// @return intentId Deterministic keccak256 identifier for this intent.
    function submitIntent(
        uint32 _dstEid,
        bytes calldata _payload,
        uint256 _deadline,
        bytes calldata _options
    ) external payable returns (bytes32 intentId) {
        if (block.timestamp > _deadline) revert DeadlineExpired();

        uint256 nonce = nonces[msg.sender]++;

        intentId = keccak256(
            abi.encodePacked(msg.sender, uint64(_dstEid), _payload, nonce, _deadline)
        );

        if (intents[intentId]) revert IntentAlreadyExists();
        intents[intentId] = true;
        intentDeadlines[intentId] = _deadline;

        // Encode intent data and send via LayerZero
        bytes memory message = abi.encode(intentId, msg.sender, _payload, _deadline);
        _lzSend(_dstEid, message, _options, MessagingFee(msg.value, 0), msg.sender);

        emit IntentSubmitted(
            intentId,
            msg.sender,
            uint64(_dstEid),
            _payload,
            nonce,
            _deadline
        );
    }

    // --- LayerZero Receive (proof from remote chain) ---
    /// @notice Handles incoming LayerZero messages containing execution proofs from Sui.
    /// @dev Decodes the message as `(bytes32 intentId, bytes proof)` and marks the intent
    ///      as executed. Only called by the LayerZero endpoint (enforced by OApp).
    function _lzReceive(
        Origin calldata /*_origin*/,
        bytes32 /*_guid*/,
        bytes calldata _message,
        address /*_executor*/,
        bytes calldata /*_extraData*/
    ) internal override {
        (bytes32 intentId, bytes memory proof) = abi.decode(_message, (bytes32, bytes));
        _markExecuted(intentId, proof);
    }

    // --- Hybrid relayer path (backward-compatible) ---
    /// @notice Allows the trusted relayer to confirm off-chain execution of an intent.
    /// @dev This is the hybrid path: a trusted relayer watches for Walrus storage completion
    ///      off-chain and submits the proof directly, bypassing the LayerZero return message.
    /// @param _intentId The deterministic identifier of the intent to confirm.
    /// @param _proof Opaque proof data attesting that the storage was executed on Walrus.
    function confirmExecution(
        bytes32 _intentId,
        bytes calldata _proof
    ) external onlyRelayer {
        _markExecuted(_intentId, _proof);
    }

    // --- Internal execution logic ---
    /// @notice Shared validation and state update for both execution paths.
    /// @dev Reverts if the intent does not exist, was already executed, or its deadline has
    ///      passed. On success, sets `executed[_intentId]` and emits `IntentExecuted`.
    /// @param _intentId The deterministic identifier of the intent.
    /// @param _proof Opaque proof data to emit alongside the execution event.
    function _markExecuted(bytes32 _intentId, bytes memory _proof) internal {
        if (!intents[_intentId]) revert IntentNotFound();
        if (executed[_intentId]) revert AlreadyExecuted();
        if (block.timestamp > intentDeadlines[_intentId]) revert DeadlineExpired();

        executed[_intentId] = true;
        emit IntentExecuted(_intentId, _proof);
    }

    // --- Fee estimation ---
    /// @notice Estimates the LayerZero messaging fee for a `submitIntent` call.
    /// @dev Builds the same ABI-encoded message that `submitIntent` would send (using a
    ///      zeroed intent ID since the actual ID is not known before submission) and
    ///      delegates to the internal `_quote` helper provided by OApp.
    /// @param _dstEid LayerZero endpoint ID of the destination chain.
    /// @param _payload Arbitrary data describing the storage intent.
    /// @param _deadline Unix timestamp after which the intent cannot be executed.
    /// @param _options LayerZero messaging options (gas, executor settings, etc.).
    /// @return fee The estimated native and LZ token fees required for the message.
    function quote(
        uint32 _dstEid,
        bytes calldata _payload,
        uint256 _deadline,
        bytes calldata _options
    ) external view returns (MessagingFee memory fee) {
        bytes memory message = abi.encode(bytes32(0), msg.sender, _payload, _deadline);
        return _quote(_dstEid, message, _options, false);
    }

    // --- Admin ---
    /// @notice Updates the trusted relayer address. Only callable by the contract owner.
    /// @dev Reverts with `ZeroAddress` if `_relayer` is the zero address.
    /// @param _relayer The new relayer address to authorise for `confirmExecution`.
    function setRelayer(address _relayer) external onlyOwner {
        if (_relayer == address(0)) revert ZeroAddress();
        address old = trustedRelayer;
        trustedRelayer = _relayer;
        emit RelayerUpdated(old, _relayer);
    }

    // --- View ---
    /// @notice Computes the deterministic intent ID for the given parameters.
    /// @dev Uses `abi.encodePacked` and `keccak256`, matching the derivation in `submitIntent`.
    /// @param _sender The address that would submit the intent.
    /// @param _targetChainId The destination chain EID (cast to uint64).
    /// @param _payload The storage intent payload.
    /// @param _nonce The sender's nonce at the time of submission.
    /// @param _deadline The deadline timestamp for the intent.
    /// @return The keccak256 intent identifier.
    function getIntentId(
        address _sender,
        uint64 _targetChainId,
        bytes calldata _payload,
        uint256 _nonce,
        uint256 _deadline
    ) external pure returns (bytes32) {
        return keccak256(
            abi.encodePacked(_sender, _targetChainId, _payload, _nonce, _deadline)
        );
    }
}
