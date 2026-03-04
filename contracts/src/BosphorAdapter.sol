// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { OApp, Origin, MessagingFee, MessagingReceipt } from "@layerzerolabs/oapp-evm/contracts/oapp/OApp.sol";

contract BosphorAdapter is OApp {
    // --- Types ---
    struct Intent {
        address sender;
        uint64 targetChainId;
        bytes payload;
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
    constructor(
        address _endpoint,
        address _delegate,
        address _trustedRelayer
    ) OApp(_endpoint, _delegate) {
        if (_trustedRelayer == address(0)) revert ZeroAddress();
        trustedRelayer = _trustedRelayer;
    }

    // --- Core ---
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
    function confirmExecution(
        bytes32 _intentId,
        bytes calldata _proof
    ) external onlyRelayer {
        _markExecuted(_intentId, _proof);
    }

    // --- Internal execution logic ---
    function _markExecuted(bytes32 _intentId, bytes memory _proof) internal {
        if (!intents[_intentId]) revert IntentNotFound();
        if (executed[_intentId]) revert AlreadyExecuted();
        if (block.timestamp > intentDeadlines[_intentId]) revert DeadlineExpired();

        executed[_intentId] = true;
        emit IntentExecuted(_intentId, _proof);
    }

    // --- Fee estimation ---
    function quote(
        uint32 _dstEid,
        bytes calldata _payload,
        uint256 _deadline,
        bytes calldata _options
    ) external view returns (MessagingFee memory) {
        bytes memory message = abi.encode(bytes32(0), msg.sender, _payload, _deadline);
        return _quote(_dstEid, message, _options, false);
    }

    // --- Admin ---
    function setRelayer(address _relayer) external onlyOwner {
        if (_relayer == address(0)) revert ZeroAddress();
        address old = trustedRelayer;
        trustedRelayer = _relayer;
        emit RelayerUpdated(old, _relayer);
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
