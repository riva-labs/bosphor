// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title EscrowVault
/// @author Riva Labs
/// @notice Per-intent payment escrow with proof-gated release and deadline refund.
/// @dev DLN-style origin-chain escrow. The payment is locked at submit (keyed by
///      intent id), released to the relayer beneficiary ONLY when a genuine
///      Sui-originated LayerZero proof lands, and refunded to the payer by anyone
///      after the deadline. Release is keyed on the proof plus the intent id, never
///      on the caller's address. Payouts use the pull-payment pattern (credit then
///      `withdraw()`), and every fund-moving path follows checks-effects-interactions
///      under a reentrancy guard. This slice whitelists the native token only;
///      the `token` field is carried for the USDC fast-follow.
abstract contract EscrowVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Lifecycle of an escrowed payment.
    enum EscrowStatus {
        None,
        Pending,
        Released,
        Refunded
    }

    /// @notice A single escrowed payment, keyed by intent id.
    struct Escrow {
        address payer;
        address token; // address(0) == native
        uint256 amount;
        uint64 deadline;
        EscrowStatus status;
    }

    /// @notice Sentinel for the native token in the `token` field.
    address internal constant NATIVE_TOKEN = address(0);

    /// @notice Escrow record per intent id.
    mapping(bytes32 => Escrow) public escrows;

    /// @notice Native balance each address may `withdraw()` (pull payment).
    mapping(address => uint256) public withdrawable;

    /// @notice ERC20 balance each address may `withdrawToken()` (token => addr => amount).
    mapping(address => mapping(address => uint256)) public withdrawableToken;

    // --- Events ---

    /// @notice Emitted when a payment is escrowed at submit time.
    event EscrowOpened(bytes32 indexed intentId, address indexed payer, address token, uint256 amount, uint64 deadline);

    /// @notice Emitted when an escrow is released to a beneficiary on a valid proof.
    event EscrowReleased(bytes32 indexed intentId, address indexed to, uint256 amount);

    /// @notice Emitted when an escrow is refunded to the payer after the deadline.
    event EscrowRefunded(bytes32 indexed intentId, address indexed payer, uint256 amount);

    /// @notice Emitted when an address withdraws its accrued native balance.
    event Withdrawn(address indexed to, uint256 amount);

    /// @notice Emitted when an address withdraws an accrued ERC20 balance.
    event WithdrawnToken(address indexed token, address indexed to, uint256 amount);

    // --- Errors ---

    /// @notice Thrown when opening an escrow for an intent id that already has one.
    error EscrowAlreadyExists();
    /// @notice Thrown when acting on an escrow that is not in the Pending state.
    error EscrowNotPending();
    /// @notice Thrown when refunding before the deadline has passed.
    error DeadlineNotReached();
    /// @notice Thrown when there is nothing to withdraw.
    error NothingToWithdraw();
    /// @notice Thrown when a native transfer fails.
    error TransferFailed();
    /// @notice Thrown when a non-native token is used where only native is allowed.
    error UnsupportedToken();

    // --- Internal escrow transitions ---

    /// @notice Open a native escrow for an intent. CEI: sets state before any external effect.
    /// @dev The caller is responsible for having received `amount` of native value.
    function _openNativeEscrow(bytes32 _intentId, address _payer, uint256 _amount, uint64 _deadline) internal {
        if (escrows[_intentId].status != EscrowStatus.None) revert EscrowAlreadyExists();
        escrows[_intentId] =
            Escrow({ payer: _payer, token: NATIVE_TOKEN, amount: _amount, deadline: _deadline, status: EscrowStatus.Pending });
        emit EscrowOpened(_intentId, _payer, NATIVE_TOKEN, _amount, _deadline);
    }

    /// @notice Open an ERC20 escrow for an intent. The caller must already have
    ///         received `amount` of `token` into this contract (e.g. via a Permit2
    ///         witness transfer bound to the intent id).
    function _openTokenEscrow(
        bytes32 _intentId,
        address _payer,
        address _token,
        uint256 _amount,
        uint64 _deadline
    ) internal {
        if (_token == NATIVE_TOKEN) revert UnsupportedToken();
        if (escrows[_intentId].status != EscrowStatus.None) revert EscrowAlreadyExists();
        escrows[_intentId] =
            Escrow({ payer: _payer, token: _token, amount: _amount, deadline: _deadline, status: EscrowStatus.Pending });
        emit EscrowOpened(_intentId, _payer, _token, _amount, _deadline);
    }

    /// @notice Release a pending escrow to a beneficiary (credited for pull withdrawal).
    /// @dev Effects (status + credit) happen before the event; no value moves here, so
    ///      double-release is impossible once status leaves Pending. Native and ERC20
    ///      escrows credit their respective pull-payment ledgers.
    function _releaseEscrow(bytes32 _intentId, address _to) internal {
        Escrow storage e = escrows[_intentId];
        if (e.status != EscrowStatus.Pending) revert EscrowNotPending();
        e.status = EscrowStatus.Released;
        _credit(e.token, _to, e.amount);
        emit EscrowReleased(_intentId, _to, e.amount);
    }

    /// @notice Refund a pending escrow to its payer once the deadline has passed.
    function _refundEscrow(bytes32 _intentId) internal {
        Escrow storage e = escrows[_intentId];
        if (e.status != EscrowStatus.Pending) revert EscrowNotPending();
        if (block.timestamp <= e.deadline) revert DeadlineNotReached();
        e.status = EscrowStatus.Refunded;
        _credit(e.token, e.payer, e.amount);
        emit EscrowRefunded(_intentId, e.payer, e.amount);
    }

    /// @dev Credit the right pull-payment ledger for a native or ERC20 escrow.
    function _credit(address _token, address _to, uint256 _amount) private {
        if (_token == NATIVE_TOKEN) withdrawable[_to] += _amount;
        else withdrawableToken[_token][_to] += _amount;
    }

    // --- Pull payment ---

    /// @notice Withdraw the caller's accrued native balance.
    /// @dev CEI under nonReentrant: zero the credit before the external call.
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        (bool ok,) = payable(msg.sender).call{ value: amount }("");
        if (!ok) revert TransferFailed();
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Withdraw the caller's accrued balance of an ERC20 token.
    /// @dev CEI under nonReentrant: zero the credit before the token transfer.
    function withdrawToken(address _token) external nonReentrant {
        uint256 amount = withdrawableToken[_token][msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawableToken[_token][msg.sender] = 0;
        IERC20(_token).safeTransfer(msg.sender, amount);
        emit WithdrawnToken(_token, msg.sender, amount);
    }

    // --- Views ---

    /// @notice Full escrow record for an intent.
    function getEscrow(bytes32 _intentId) external view returns (Escrow memory) {
        return escrows[_intentId];
    }
}
