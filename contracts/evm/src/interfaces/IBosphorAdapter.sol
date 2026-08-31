// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { MessagingFee } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

/// @title IBosphorAdapter
/// @author Riva Labs
/// @notice Interface for the Bosphor cross-chain storage intent adapter.
/// @dev Enables integrators to interact with the BosphorAdapter without importing
///      the full contract and its LayerZero dependencies. Milestone 3 replaces the
///      arbitrary payload with a compact storage commitment that references a Walrus
///      blob by id. The cross-chain message carries only the intent id and the
///      encoded commitment, never the raw blob contents.
interface IBosphorAdapter {
    // --- Events ---

    /// @notice Emitted when a new storage intent is submitted and sent cross-chain.
    /// @param intentId Deterministic keccak256 identifier for the intent.
    /// @param sender Address that submitted the intent.
    /// @param targetChainId LayerZero endpoint ID of the destination chain.
    /// @param blobId Walrus blob identifier committed to by this intent.
    /// @param size Blob size in bytes.
    /// @param encodingType Walrus encoding type discriminator.
    /// @param storageEpochs Number of Walrus epochs the blob is stored for.
    /// @param nonce Sender's nonce at the time of submission.
    /// @param deadline Unix timestamp after which the intent cannot be executed.
    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed sender,
        uint64 targetChainId,
        bytes32 blobId,
        uint32 size,
        uint8 encodingType,
        uint32 storageEpochs,
        uint64 nonce,
        uint64 deadline
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

    /// @notice Thrown when an execution proof references a blob id that does not match
    ///         the blob id committed to at submission time.
    error BlobIdMismatch();

    // --- Core ---

    /// @notice Submits a storage intent and sends it to the destination chain via LayerZero.
    /// @dev The cross-chain message is `abi.encodePacked(intentId, CommitmentCodec.encode(c))`,
    ///      a fixed 82 bytes (32-byte intent id plus the 50-byte versioned commitment). No raw blob
    ///      contents are ever placed on the wire. The caller must attach enough native gas to
    ///      cover the LayerZero messaging fee (use `quote` to estimate). The intent id is
    ///      deterministically derived from the commitment, the sender, and the sender's nonce.
    /// @param _dstEid LayerZero endpoint ID of the destination chain (e.g. 40378 for Sui testnet).
    /// @param _blobId Walrus blob identifier the intent commits to.
    /// @param _size Blob size in bytes.
    /// @param _encodingType Walrus encoding type discriminator.
    /// @param _storageEpochs Number of Walrus epochs the blob is stored for.
    /// @param _deadline Unix timestamp after which the intent cannot be executed.
    /// @param _options LayerZero messaging options (gas, executor settings, etc.).
    /// @return intentId Deterministic keccak256 identifier for this intent.
    function submitIntent(
        uint32 _dstEid,
        bytes32 _blobId,
        uint32 _size,
        uint8 _encodingType,
        uint32 _storageEpochs,
        uint64 _deadline,
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
    /// @dev Builds the same 82-byte message that `submitIntent` would send (using a zeroed
    ///      intent id placeholder since the actual id is not known before submission) and
    ///      delegates to the internal `_quote` helper provided by OApp.
    /// @param _dstEid LayerZero endpoint ID of the destination chain.
    /// @param _blobId Walrus blob identifier the intent commits to.
    /// @param _size Blob size in bytes.
    /// @param _encodingType Walrus encoding type discriminator.
    /// @param _storageEpochs Number of Walrus epochs the blob is stored for.
    /// @param _deadline Unix timestamp after which the intent cannot be executed.
    /// @param _options LayerZero messaging options (gas, executor settings, etc.).
    /// @return fee The estimated native and LZ token fees required for the message.
    function quote(
        uint32 _dstEid,
        bytes32 _blobId,
        uint32 _size,
        uint8 _encodingType,
        uint32 _storageEpochs,
        uint64 _deadline,
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

    /// @notice Returns the Walrus blob id committed to by a given intent.
    /// @param intentId The intent identifier to query.
    /// @return The committed Walrus blob id (zero if the intent does not exist).
    function committedBlobId(bytes32 intentId) external view returns (bytes32);

    /// @notice Returns the deadline for a given intent.
    /// @param intentId The intent identifier to query.
    /// @return The Unix timestamp deadline for the intent.
    function intentDeadlines(bytes32 intentId) external view returns (uint256);

    /// @notice Returns the current nonce for a given sender.
    /// @param sender The address to query.
    /// @return The current nonce value.
    function nonces(address sender) external view returns (uint256);

    /// @notice Computes the deterministic intent id for the given commitment and sender.
    /// @dev Matches the derivation in `submitIntent`: hashes the encoded commitment, the
    ///      32-byte left-padded sender, and the 8-byte nonce.
    /// @param _sender The address that would submit the intent.
    /// @param _blobId Walrus blob identifier the intent commits to.
    /// @param _size Blob size in bytes.
    /// @param _encodingType Walrus encoding type discriminator.
    /// @param _storageEpochs Number of Walrus epochs the blob is stored for.
    /// @param _deadline The deadline timestamp for the intent.
    /// @param _nonce The sender's nonce at the time of submission.
    /// @return The keccak256 intent identifier.
    function getIntentId(
        address _sender,
        bytes32 _blobId,
        uint32 _size,
        uint8 _encodingType,
        uint32 _storageEpochs,
        uint64 _deadline,
        uint64 _nonce
    ) external pure returns (bytes32);
}
