/**
 * The Bosphor EVM adapter ABI (BosphorEscrowAdapter), in ethers human-readable
 * form. It covers everything an integrator calls or listens to: submitting and
 * quoting an intent, reading its execution state, the escrow lifecycle
 * (`getEscrow`, `refund`), the events the SDK parses, and the custom errors so
 * reverts decode to a readable name. Owner-only admin functions are left out.
 *
 * Mirrors `contracts/evm/src/BosphorEscrowAdapter.sol` (plus `EscrowVault.sol`
 * and `interfaces/IBosphorAdapter.sol`).
 */
export const ADAPTER_ABI: readonly string[] = [
  // --- Intent submission + fee estimation ---
  "function submitIntent(uint32 dstEid, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, bytes options) payable returns (bytes32 intentId)",
  "function quote(uint32 dstEid, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee) fee)",
  "function getIntentId(address sender, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 deadline, uint64 nonce) pure returns (bytes32)",
  "function nonces(address sender) view returns (uint256)",

  // --- Intent state ---
  "function intents(bytes32 intentId) view returns (bool)",
  "function executed(bytes32 intentId) view returns (bool)",
  "function committedBlobId(bytes32 intentId) view returns (bytes32)",
  "function intentDeadlines(bytes32 intentId) view returns (uint256)",
  "function trustedRelayer() view returns (address)",

  // --- Escrow (priced path) ---
  "function getEscrow(bytes32 intentId) view returns (tuple(address payer, address token, uint256 amount, uint64 deadline, uint8 status))",
  "function refund(bytes32 intentId)",
  "function withdrawable(address account) view returns (uint256)",
  "function withdraw()",

  // --- Events ---
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)",
  "event IntentExecuted(bytes32 indexed intentId, bytes proof)",
  "event EscrowOpened(bytes32 indexed intentId, address indexed payer, address token, uint256 amount, uint64 deadline)",
  "event EscrowReleased(bytes32 indexed intentId, address indexed to, uint256 amount)",
  "event EscrowRefunded(bytes32 indexed intentId, address indexed payer, uint256 amount)",

  // --- Errors ---
  "error DeadlineExpired()",
  "error IntentAlreadyExists()",
  "error IntentNotFound()",
  "error AlreadyExecuted()",
  "error BlobIdMismatch()",
  "error UnknownMessageType()",
  "error InsufficientPayment()",
  "error EscrowAlreadyExists()",
  "error EscrowNotPending()",
  "error DeadlineNotReached()",
  "error NothingToWithdraw()",
  "error TransferFailed()",
];

/** Escrow status as returned in `getEscrow(...).status`. */
export const EscrowStatus: {
  readonly None: 0;
  readonly Pending: 1;
  readonly Released: 2;
  readonly Refunded: 3;
} = { None: 0, Pending: 1, Released: 2, Refunded: 3 };
