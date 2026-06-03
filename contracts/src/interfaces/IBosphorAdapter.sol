// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

/// @title IBosphorAdapter
/// @author Riva Labs
/// @notice Interface for the Bosphor cross-chain storage intent adapter.
/// @dev Enables integrators to interact with the BosphorAdapter without importing
///      the full contract and its LayerZero dependencies.
interface IBosphorAdapter {
    // --- Structs ---

    /// @notice Represents a storage intent routed cross-chain.
    /// @dev Used internally for intent derivation. Included in the interface for
    ///      off-chain tooling that needs to reconstruct intent data.
    struct Intent {
        address sender;
        uint64 targetChainId;
        bytes payload;
        uint256 nonce;
        uint256 deadline;
    }

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
    /// @param intentId Deterministic keccak256 identifier for the intent.
    /// @param proof Opaque proof data attesting that storage was executed on Walrus.
    event IntentExecuted(bytes32 indexed intentId, bytes proof);

    /// @notice Emitted when the owner changes the trusted relayer address.
    /// @param oldRelayer Previous relayer address.
    /// @param newRelayer New relayer address.
    event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);

    // --- Errors ---

    /// @notice Thrown when the provided deadline has already passed.
    error DeadlineExpired();

    /// @notice Thrown when an intent with the same ID already exists.
    error IntentAlreadyExists();

    /// @notice Thrown when the referenced intent does not exist.
    error IntentNotFound();

    /// @notice Thrown when the intent has already been executed.
    error AlreadyExecuted();

    /// @notice Thrown when a zero address is provided where a non-zero address is required.
    error ZeroAddress();

    /// @notice Thrown when an incoming LayerZero message has an unrecognised type discriminator.
    error UnknownMessageType();

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
    ) external view returns (MessagingFee memory fee);

    // --- Admin ---

    /// @notice Updates the trusted relayer address. Only callable by the contract owner.
    /// @dev Reverts with `ZeroAddress` if `_relayer` is the zero address.
    /// @param _relayer The new relayer address for off-chain identification.
    function setRelayer(address _relayer) external;

    // --- View ---

    /// @notice Returns the current trusted relayer address.
    /// @return The address of the trusted relayer.
    function trustedRelayer() external view returns (address);

    /// @notice Returns whether an intent with the given ID exists.
    /// @param intentId The intent identifier to query.
    /// @return True if the intent has been submitted.
    function intents(bytes32 intentId) external view returns (bool);

    /// @notice Returns whether an intent has been executed.
    /// @param intentId The intent identifier to query.
    /// @return True if the intent has been executed.
    function executed(bytes32 intentId) external view returns (bool);

    /// @notice Returns the deadline for a given intent.
    /// @param intentId The intent identifier to query.
    /// @return The Unix timestamp deadline for the intent.
    function intentDeadlines(bytes32 intentId) external view returns (uint256);

    /// @notice Returns the current nonce for a given sender.
    /// @param sender The address to query.
    /// @return The current nonce value.
    function nonces(address sender) external view returns (uint256);

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
    ) external pure returns (bytes32);
}
