// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

/// @title IBosphorAdapter
/// @author Riva Labs
/// @notice Interface for the Bosphor cross-chain storage intent router.
///         Enables integrators to interact with the adapter without importing
///         the full contract and its LayerZero OApp dependencies.
interface IBosphorAdapter {
    // --- Events ---

    /// @notice Emitted when a new storage intent is submitted and sent cross-chain.
    /// @param intentId Deterministic keccak256 identifier for the intent.
    /// @param sender Address that submitted the intent.
    /// @param targetChainId LayerZero endpoint ID of the destination chain.
    /// @param payload Arbitrary data describing the storage intent.
    /// @param nonce Sender's nonce at the time of submission.
    /// @param deadline Unix timestamp after which the intent cannot be executed.
    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed sender,
        uint64 targetChainId,
        bytes payload,
        uint256 nonce,
        uint256 deadline
    );

    /// @notice Emitted when an intent is marked as executed with its proof.
    /// @param intentId Deterministic identifier of the executed intent.
    /// @param proof Opaque proof data attesting execution on Walrus.
    event IntentExecuted(bytes32 indexed intentId, bytes proof);

    /// @notice Emitted when the owner changes the trusted relayer address.
    /// @param oldRelayer Previous relayer address.
    /// @param newRelayer New relayer address.
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    // --- Errors ---

    /// @notice Thrown when the current timestamp exceeds the intent deadline.
    error DeadlineExpired();
    /// @notice Thrown when an intent with the same ID already exists.
    error IntentAlreadyExists();
    /// @notice Thrown when the referenced intent does not exist.
    error IntentNotFound();
    /// @notice Thrown when attempting to execute an already-executed intent.
    error AlreadyExecuted();
    /// @notice Thrown when a zero address is provided where a non-zero address is required.
    error ZeroAddress();
    /// @notice Thrown when an incoming LayerZero message has an unrecognized type prefix.
    error UnknownMessageType();

    // --- State Accessors ---

    /// @notice Returns the trusted relayer address used for off-chain identification.
    function trustedRelayer() external view returns (address);

    /// @notice Returns true if an intent with the given ID has been submitted.
    /// @param intentId The deterministic intent identifier.
    function intents(bytes32 intentId) external view returns (bool);

    /// @notice Returns true if an intent with the given ID has been executed.
    /// @param intentId The deterministic intent identifier.
    function executed(bytes32 intentId) external view returns (bool);

    /// @notice Returns the deadline timestamp for a submitted intent.
    /// @param intentId The deterministic intent identifier.
    function intentDeadlines(bytes32 intentId) external view returns (uint256);

    /// @notice Returns the current nonce for a given sender.
    /// @param sender The address to query.
    function nonces(address sender) external view returns (uint256);

    // --- Core ---

    /// @notice Submits a storage intent and sends it to the destination chain via LayerZero.
    /// @dev The caller must attach enough native gas to cover the LayerZero messaging fee
    ///      (use `quote` to estimate).
    /// @param _dstEid LayerZero endpoint ID of the destination chain.
    /// @param _payload Arbitrary data describing the storage intent.
    /// @param _deadline Unix timestamp after which the intent cannot be executed.
    /// @param _options LayerZero messaging options (gas, executor settings, etc.).
    /// @return intentId Deterministic keccak256 identifier for this intent.
    function submitIntent(
        uint32 _dstEid,
        bytes calldata _payload,
        uint256 _deadline,
        bytes calldata _options
    ) external payable returns (bytes32 intentId);

    /// @notice Emergency fallback: allows the owner to manually confirm execution of an intent.
    /// @dev The primary path for proof receipt is `_lzReceive` with a type 1 message from Sui.
    ///      This function is retained for disaster recovery only.
    /// @param _intentId The deterministic identifier of the intent to confirm.
    /// @param _proof Opaque proof data attesting that the storage was executed on Walrus.
    function confirmExecution(
        bytes32 _intentId,
        bytes calldata _proof
    ) external;

    // --- Fee Estimation ---

    /// @notice Estimates the LayerZero messaging fee for a `submitIntent` call.
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
    ) external view returns (MessagingFee memory fee);

    // --- Admin ---

    /// @notice Updates the trusted relayer address. Only callable by the contract owner.
    /// @param _relayer The new relayer address for off-chain identification.
    function setRelayer(address _relayer) external;

    // --- View ---

    /// @notice Computes the deterministic intent ID for the given parameters.
    /// @param _sender The address that would submit the intent.
    /// @param _targetChainId The destination chain EID.
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
    ) external pure returns (bytes32);
}
