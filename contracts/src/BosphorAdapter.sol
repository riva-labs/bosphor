// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract BosphorAdapter {
    // --- Types ---
    struct Intent {
        address sender;
        uint64 targetChainId; // Sui chain identifier
        bytes payload;        // arbitrary data to store on Walrus
        uint256 nonce;
        uint256 deadline;
    }

    // --- Events ---
    event IntentSubmitted(
        bytes32 indexed intentId,
        address indexed sender,
        uint64 targetChainId,
        bytes payload,
        uint256 nonce,
        uint256 deadline
    );

    event IntentExecuted(bytes32 indexed intentId, bytes proof);

    // --- State ---
    address public owner;
    address public trustedRelayer;
    mapping(bytes32 => bool) public intents;     // intentId => submitted
    mapping(bytes32 => bool) public executed;     // intentId => executed
    mapping(address => uint256) public nonces;

    // --- Errors ---
    error DeadlineExpired();
    error InvalidNonce();
    error IntentAlreadyExists();
    error IntentNotFound();
    error AlreadyExecuted();
    error OnlyRelayer();
    error OnlyOwner();

    // --- Modifiers ---
    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != trustedRelayer) revert OnlyRelayer();
        _;
    }

    // --- Constructor ---
    constructor(address _trustedRelayer) {
        owner = msg.sender;
        trustedRelayer = _trustedRelayer;
    }

    // --- Core ---
    function submitIntent(
        uint64 _targetChainId,
        bytes calldata _payload,
        uint256 _deadline
    ) external returns (bytes32 intentId) {
        if (block.timestamp > _deadline) revert DeadlineExpired();

        uint256 nonce = nonces[msg.sender]++;

        intentId = keccak256(
            abi.encodePacked(msg.sender, _targetChainId, _payload, nonce, _deadline)
        );

        if (intents[intentId]) revert IntentAlreadyExists();
        intents[intentId] = true;

        emit IntentSubmitted(
            intentId,
            msg.sender,
            _targetChainId,
            _payload,
            nonce,
            _deadline
        );
    }

    function confirmExecution(
        bytes32 _intentId,
        bytes calldata _proof
    ) external onlyRelayer {
        if (!intents[_intentId]) revert IntentNotFound();
        if (executed[_intentId]) revert AlreadyExecuted();

        executed[_intentId] = true;

        emit IntentExecuted(_intentId, _proof);
    }

    // --- Admin ---
    function setRelayer(address _relayer) external onlyOwner {
        trustedRelayer = _relayer;
    }

    // --- View ---
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
