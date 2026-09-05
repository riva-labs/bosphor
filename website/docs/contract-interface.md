---
sidebar_position: 5
title: Contract Interface Reference
---

# Contract Interface Reference

:::tip Recommended path
Most integrators should use `@bosphor/sdk` rather than hand-rolling contract calls. The SDK computes the Walrus blob id locally, submits the commitment, uploads the bytes out-of-band, and returns a verified result from one `store()` call. Guides and API reference live at [sdk.bosphor.xyz](https://sdk.bosphor.xyz). Use the raw contract interface below when you need lower-level control.
:::

## IBosphorAdapter (Interface)

Integrators should import `IBosphorAdapter.sol` from `contracts/evm/src/interfaces/` rather than the full `BosphorAdapter.sol`. The interface includes all external function signatures, events, errors, and structs needed for integration.

```solidity
import { IBosphorAdapter } from "./interfaces/IBosphorAdapter.sol";
```

Bosphor moves data off the messaging layer. An intent carries a compact, fixed-size **commitment** (blob id, size, encoding, storage duration, deadline) rather than the file bytes. See [Commitment Format](commitment-format.md) for the canonical 49-byte layout and the `intentId` derivation. The file bytes are uploaded to the relayer out-of-band, never through the bridge (see [Blob ingest](public-api.md#blob-ingest-out-of-band)).

## BosphorAdapter.sol (EVM)

`BosphorAdapter` implements `IBosphorAdapter` and extends the LayerZero `OApp`.

### submitIntent

Submit a storage intent to be routed to Walrus via LayerZero. The caller commits to a Walrus blob id and its storage terms; the bytes themselves are uploaded to the relayer out-of-band.

```solidity
function submitIntent(
    uint32 _dstEid,
    bytes32 _blobId,
    uint32 _size,
    uint8 _encodingType,
    uint32 _storageEpochs,
    uint64 _deadline,
    bytes calldata _options
) external payable returns (bytes32 intentId);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `_dstEid` | uint32 | Destination chain EID. Sui testnet: `40378` |
| `_blobId` | bytes32 | Walrus blob id, computed client-side from the data |
| `_size` | uint32 | Blob size in bytes |
| `_encodingType` | uint8 | Walrus encoding type discriminant |
| `_storageEpochs` | uint32 | Storage duration in Walrus epochs |
| `_deadline` | uint64 | Unix timestamp (seconds) after which the intent expires |
| `_options` | bytes | LayerZero execution options (gas limit, etc.) |

**Returns**: `intentId`, derived as `keccak256(commitment(49) ++ sender(32) ++ nonce(u64))`. See [Commitment Format](commitment-format.md).

**Emits**: `IntentSubmitted(intentId, sender, targetChainId, blobId, size, encodingType, storageEpochs, nonce, deadline)`

### quote

Estimate the LayerZero fee for submitting an intent. Takes the same commitment fields as `submitIntent`.

```solidity
function quote(
    uint32 _dstEid,
    bytes32 _blobId,
    uint32 _size,
    uint8 _encodingType,
    uint32 _storageEpochs,
    uint64 _deadline,
    bytes calldata _options
) external view returns (MessagingFee memory);
```

**Returns**: `MessagingFee { nativeFee, lzTokenFee }`. Pass `nativeFee` as `msg.value` to `submitIntent`. Because only the 49-byte commitment crosses the bridge, the fee is flat regardless of file size.

### confirmExecution

Trusted-relayer / disaster-recovery fallback to manually confirm intent execution. Owner-only.
The primary proof path is `_lzReceive` with a type 1 message from Sui.

```solidity
function confirmExecution(
    bytes32 _intentId,
    bytes calldata _proof
) external; // onlyOwner
```

**Emits**: `IntentExecuted(intentId, proof)`

### _lzReceive (internal)

Handles incoming LayerZero messages from the remote chain. The first byte is a message type discriminator.

**Type 1 (execution proof):** Remaining bytes are ABI-encoded as `(bytes32 intentId, bytes32 blobId, uint256 endEpoch)`. The adapter checks `blobId == committedBlobId[intentId]` and reverts `BlobIdMismatch` if it differs. On success the intent is marked as executed and `IntentExecuted` is emitted with `abi.encode(blobId, endEpoch)` as proof.

Wire format: `bytes1(0x01) ++ abi.encode(intentId, blobId, endEpoch)`

### setRelayer

Update the trusted relayer address. Owner-only.

```solidity
function setRelayer(address _relayer) external; // onlyOwner
```

## BosphorEscrowAdapter.sol (EVM, Milestone 4)

The escrow adapter is the paid variant of `BosphorAdapter`. `submitIntent` is
unchanged in signature but now escrows the `msg.value` surplus above the
LayerZero fee, keyed by the intent id. Release is gated on a genuine proof; the
owner `confirmExecution` fallback marks executed but never moves escrowed funds.
See the [payment flow](./payment-flow.md) for the model and the SDK usage.

```solidity
// Deposit at submit: msg.value = LZ fee + escrow. Only the fee reaches the
// endpoint; the surplus is escrowed for this intent.
function submitIntent(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) payable returns (bytes32);

// The escrow record for an intent (status: 0 None, 1 Pending, 2 Released, 3 Refunded).
function getEscrow(bytes32 intentId) external view
    returns (address payer, address token, uint256 amount, uint64 deadline, uint8 status);

// Permissionless once the deadline passes: credits the recorded payer.
function refund(bytes32 intentId) external;

// Pull-payment: relayer withdraws released funds, payers withdraw refunds.
function withdraw() external;              // native (ETH)
function withdrawToken(address token) external; // ERC20 (USDC path)
```

Release happens inside `_lzReceive` after the returned blob id matches the
commitment: the escrow moves to the relayer's withdrawable balance. A USDC
deposit path via a Permit2 witness bound to the intent id
(`depositUsdcWithPermit2`, enabled by `setPermit2`) is available opt-in; native
is the default.

**Emits**: `RelayerUpdated(oldRelayer, newRelayer)`

### getIntentId

Compute the deterministic intent ID for a given commitment, sender, and nonce.

```solidity
function getIntentId(
    address _sender,
    bytes32 _blobId,
    uint32 _size,
    uint8 _encodingType,
    uint32 _storageEpochs,
    uint64 _deadline,
    uint64 _nonce
) external pure returns (bytes32);
```

The id is `keccak256(commitment(49) ++ sender(32, left-padded) ++ nonce(u64 big-endian))`. See [Commitment Format](commitment-format.md).

### View Functions

```solidity
function trustedRelayer() external view returns (address);
function intents(bytes32 intentId) external view returns (bool);          // intent recorded
function executed(bytes32 intentId) external view returns (bool);         // proof landed
function committedBlobId(bytes32 intentId) external view returns (bytes32); // committed Walrus blob id
function intentDeadlines(bytes32 intentId) external view returns (uint256);
function nonces(address sender) external view returns (uint256);
```

`committedBlobId` returns the blob id the adapter committed for an intent. On proof receipt the adapter checks the returned blob id equals this value and reverts `BlobIdMismatch` otherwise.

### Errors

```solidity
error DeadlineExpired();
error IntentAlreadyExists();
error IntentNotFound();
error AlreadyExecuted();
error ZeroAddress();
error UnknownMessageType();
error BlobIdMismatch();
```

## Events

```solidity
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

event IntentExecuted(bytes32 indexed intentId, bytes proof);

event RelayerUpdated(address indexed oldRelayer, address indexed newRelayer);
```

## Usage Examples (ethers.js)

The raw path below computes the commitment fields, submits the intent, then uploads the bytes out-of-band. Most integrators should prefer `@bosphor/sdk`, which does all of this in a single `store()` call; see [sdk.bosphor.xyz](https://sdk.bosphor.xyz).

### Submit an intent

```typescript
import { ethers } from "ethers";
// The SDK exposes the Walrus blob-id derivation used to build the commitment.
import { defaultComputeBlob } from "@bosphor/sdk/evm";

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
const signer = new ethers.Wallet(process.env.EVM_RELAYER_KEY, provider);

const adapter = new ethers.Contract(
  ADAPTER_ADDRESS,
  [
    "function quote(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
    "function submitIntent(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) payable returns (bytes32)",
    "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)",
  ],
  signer
);

const RELAYER_BASE_URL = "https://api.bosphor.xyz/testnet"; // mainnet: https://api.bosphor.xyz
const dstEid = 40378; // Sui testnet
const data = new TextEncoder().encode("Hello Walrus");

// Derive the Walrus blob id, size, and encoding client-side.
const { blobId, size, encodingType } = await defaultComputeBlob(data);
const storageEpochs = 5;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour
// LZ execution options: type 3 (lzReceive), gas limit 200,000 (see "LZ Options" below)
const options = "0x00030100110100000000000000000000000000030d40";

// Get fee estimate
const fee = await adapter.quote(dstEid, blobId, size, encodingType, storageEpochs, deadline, options);

// Submit intent
const tx = await adapter.submitIntent(
  dstEid, blobId, size, encodingType, storageEpochs, deadline, options,
  { value: fee.nativeFee }
);
const receipt = await tx.wait();

// Read the intentId from the IntentSubmitted event.
const submitted = receipt.logs
  .map((log) => { try { return adapter.interface.parseLog(log); } catch { return null; } })
  .find((e) => e?.name === "IntentSubmitted");
const intentId = submitted.args.intentId;
console.log("Intent submitted:", intentId);

// Upload the bytes out-of-band to the relayer (see Blob ingest).
const res = await fetch(`${RELAYER_BASE_URL}/blob/${intentId}`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream" },
  body: data,
});
if (!res.ok) throw new Error(`blob upload rejected: ${res.status}`);
```

### Listen for events

```typescript
// Listen for new intents
adapter.on(
  "IntentSubmitted",
  (intentId, sender, targetChainId, blobId, size, encodingType, storageEpochs, nonce, deadline) => {
    console.log("New intent:", intentId);
    console.log("Sender:", sender);
    console.log("Committed blob id:", blobId);
  }
);

// Listen for execution confirmations
adapter.on("IntentExecuted", (intentId, proof) => {
  const [blobId, endEpoch] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["bytes32", "uint256"],
    proof
  );
  console.log("Intent executed:", intentId);
  console.log("Walrus blob ID:", blobId);
  console.log("Expiry epoch:", endEpoch.toString());
});
```

## Usage Examples (@mysten/sui)

### Call execute_store

The relayer calls `execute_store` after uploading the bytes to Walrus and receiving a certified blob. The executor reads the committed blob id and storage epochs back from `LzReceiverConfig` and asserts the certified blob matches; relayer arguments are never trusted for the commitment.

```typescript
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

const client = new SuiClient({ url: "https://fullnode.testnet.sui.io:443" });
const keypair = Ed25519Keypair.fromSecretKey(RELAYER_SECRET_KEY);

const tx = new Transaction();

tx.moveCall({
  target: `${PACKAGE_ID}::walrus_executor::execute_store`,
  arguments: [
    tx.object(EXECUTOR_CONFIG_ID),         // ExecutorConfig (relayer auth + dedup)
    tx.object(LZ_RECEIVER_CONFIG_ID),      // LzReceiverConfig (holds the committed reference)
    tx.object(WALRUS_SYSTEM_ID),           // Walrus System object (current epoch)
    tx.pure.vector("u8", intentIdBytes),   // 32-byte intent ID
    tx.object(certifiedBlobId),            // Walrus Blob object
    tx.pure.u64(deadlineMs),               // deadline in milliseconds
    tx.object("0x6"),                      // Sui Clock object
    tx.pure.address(senderAddress),        // original sender
  ],
});

const result = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: keypair,
});
console.log("execute_store tx:", result.digest);
```

### Query intent status

```typescript
import { SuiClient } from "@mysten/sui/client";

const client = new SuiClient({ url: "https://fullnode.testnet.sui.io:443" });

// Query IntentReceived events
const events = await client.queryEvents({
  query: {
    MoveEventType: `${PACKAGE_ID}::lz_receiver::IntentReceived`,
  },
  limit: 10,
  order: "descending",
});

for (const event of events.data) {
  const { intent_id, committed_blob_id, size, storage_epochs, src_eid, nonce } =
    event.parsedJson as {
      intent_id: number[];
      committed_blob_id: string;
      size: number;
      storage_epochs: number;
      src_eid: number;
      nonce: string;
    };
  console.log("Intent:", Buffer.from(intent_id).toString("hex"));
  console.log("Committed blob id:", committed_blob_id, "size:", size);
  console.log("Source EID:", src_eid, "Nonce:", nonce);
}
```

## Sui Modules

### lz_receiver

Receives cross-chain intent messages from EVM and sends execution proofs back.

#### lz_receive

Called by the LZ executor via PTB. Consumes the hot-potato `Call`, validates the message through the OApp (peer + endpoint checks), extracts the intent ID, records the intent, and emits `IntentReceived`.

```move
public fun lz_receive(
    config: &mut LzReceiverConfig,
    oapp: &OApp,
    call: Call<LzReceiveParam, Void>,
    ctx: &mut TxContext,
)
```

Message format from EVM (M3 reference commitment, big-endian, exactly 81 bytes):

| Offset | Length | Field |
|--------|--------|-------|
| 0:32 | 32 | intentId (bytes32) |
| 32:81 | 49 | commitment: `blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)` |

The commitment is decoded into the `IntentRecord`, which stores the committed blob id and storage epochs for `execute_store` to verify against. No raw blob bytes are on the wire. See [Commitment Format](commitment-format.md).

**Aborts**: `EInvalidMessageLength` (1) if the message is not exactly 81 bytes, `EIntentAlreadyReceived` (0) if duplicate.

#### lz_send_proof

Initiates an LZ send of the execution proof back to EVM. Builds the type-1 proof message and calls `oapp::lz_send()`. Returns a hot-potato `Call` that must be routed through the LZ endpoint in the same PTB, then finalized via `confirm_lz_send_proof`.

```move
public fun lz_send_proof(
    config: &LzReceiverConfig,
    oapp: &mut OApp,
    intent_id: vector<u8>,    // 32 bytes
    blob_id: vector<u8>,      // 32 bytes
    end_epoch: u64,
    dst_eid: u32,             // e.g. 40161 for Sepolia
    options: vector<u8>,
    native_fee: Coin<SUI>,
    ctx: &mut TxContext,
): Call<SendParam, MessagingReceipt>
```

**Aborts**: `EUnauthorizedRelayer` (2) if caller is not the relayer, `EIntentNotReceived` (4) if intent not recorded.

#### confirm_lz_send_proof

Finalizes the LZ send and handles coin refunds. Must be called after the `Call` from `lz_send_proof` has been executed by the LZ endpoint. Emits `ProofSent`.

```move
public fun confirm_lz_send_proof(
    config: &LzReceiverConfig,
    oapp: &mut OApp,
    call: Call<SendParam, MessagingReceipt>,
    ctx: &mut TxContext,
)
```

#### quote_proof

Estimates the LZ fee for sending a proof message. Returns a hot-potato `Call` that must be routed through the endpoint, then finalized via `confirm_quote_proof`.

```move
public fun quote_proof(
    config: &LzReceiverConfig,
    oapp: &OApp,
    intent_id: vector<u8>,
    blob_id: vector<u8>,
    end_epoch: u64,
    dst_eid: u32,
    options: vector<u8>,
    ctx: &mut TxContext,
): Call<QuoteParam, MessagingFee>
```

#### confirm_quote_proof

Finalizes a quote and returns the estimated messaging fee.

```move
public fun confirm_quote_proof(
    config: &LzReceiverConfig,
    oapp: &OApp,
    call: Call<QuoteParam, MessagingFee>,
): MessagingFee
```

#### set_relayer

Updates the authorized relayer address. Admin-only (requires `AdminCap`).

```move
entry fun set_relayer(
    config: &mut LzReceiverConfig,
    admin_cap: &AdminCap,
    oapp: &OApp,
    new_relayer: address,
)
```

**Aborts**: `EZeroAddress` (3) if `new_relayer` is `@0x0`.

#### is_received

Returns `true` if an intent with the given ID has been received.

```move
public fun is_received(config: &LzReceiverConfig, intent_id: vector<u8>): bool
```

### lz_receiver Events

#### IntentReceived

Emitted when `lz_receive` processes an incoming LZ message.

```move
public struct IntentReceived has copy, drop {
    intent_id: vector<u8>,   // 32 bytes, matches EVM intentId
    committed_blob_id: u256, // committed Walrus blob id (big-endian u256)
    size: u32,               // committed blob size in bytes
    encoding_type: u8,       // committed Walrus encoding type
    storage_epochs: u32,     // committed storage duration in epochs
    deadline: u64,           // committed deadline (unix timestamp)
    src_eid: u32,            // Source chain EID (40161 for Sepolia)
    nonce: u64,              // LZ message nonce
    guid: Bytes32,           // LZ message GUID
}
```

#### ProofSent

Emitted when `confirm_lz_send_proof` completes a proof send back to EVM.

```move
public struct ProofSent has copy, drop {
    intent_id: vector<u8>,   // 32 bytes
    blob_id: vector<u8>,     // 32 bytes
    end_epoch: u64,          // Walrus blob expiry epoch
    dst_eid: u32,            // Destination EID (40161 for Sepolia)
    nonce: u64,              // LZ message nonce
    guid: Bytes32,           // LZ message GUID
}
```

### lz_receiver Errors

| Code | Name | Description |
|------|------|-------------|
| 0 | `EIntentAlreadyReceived` | Intent with this ID was already received |
| 1 | `EInvalidMessageLength` | Message is not exactly 81 bytes (intentId(32) ++ commitment(49)) |
| 2 | `EUnauthorizedRelayer` | Caller is not the authorized relayer |
| 3 | `EZeroAddress` | Relayer address must not be zero |
| 4 | `EIntentNotReceived` | Intent must exist before sending proof |

### walrus_executor

#### execute_store

Accepts a certified Walrus `Blob` object, verifies certification and deadline, asserts the certified blob matches the committed reference recorded by `lz_receive` (blob id and storage epochs, read from `LzReceiverConfig`, not from relayer arguments), records execution, emits `StorageExecuted`, and transfers blob and receipt to the original sender. Relayer-only.

```move
public fun execute_store(
    config: &mut ExecutorConfig,
    lz_config: &LzReceiverConfig,
    system: &System,
    intent_id: vector<u8>,
    blob: Blob,
    deadline_ms: u64,
    clock: &Clock,
    original_sender: address,
    ctx: &mut TxContext,
)
```

**Aborts**: `ENotRelayer` (0), `EBlobNotCertified` (1), `EIntentAlreadyExecuted` (2), `EDeadlineExpired` (3), `EBlobIdMismatch` (4) if the certified blob id differs from the commitment, `EInsufficientStorageEpochs` (5) if the blob does not cover the committed epochs.

#### StorageExecuted

Emitted when `execute_store` records a Walrus blob.

```move
public struct StorageExecuted has copy, drop {
    intent_id: vector<u8>,   // 32 bytes
    walrus_blob_id: u256,    // Walrus blob identifier
    end_epoch: u32,          // Blob expiry epoch
    executor: address,       // Relayer address
}
```

## Wire Formats

### Step 1: Intent Delivery (EVM to Sui)

`abi.encodePacked(intentId, CommitmentCodec.encode(commitment))` sent via `_lzSend`: `intentId(32) ++ commitment(49)` = 81 bytes. No raw blob bytes are on the wire. See [Commitment Format](commitment-format.md).

### Step 2: Proof Verification (Sui to EVM)

Type 1 proof message: `bytes1(0x01) ++ abi.encode(intentId, blobId, endEpoch)`

Total: 97 bytes (1 type byte + 32 intentId + 32 blobId + 32 endEpoch).

## LZ Options

Default options for Sui delivery:

```
0x00030100110100000000000000000000000000030d40
```

Byte breakdown:

| Bytes | Value | Meaning |
|-------|-------|---------|
| `0003` | 3 | Options type (lzReceive execution) |
| `01` | 1 | Number of option entries |
| `0011` | 17 | Entry length in bytes |
| `01` | 1 | Worker ID (executor) |
| `00000000000000000000000000030d40` | 200,000 | Gas limit for `_lzReceive` on the destination chain |

The 200,000 gas limit is sufficient for Bosphor's `_lzReceive` handler. Increase it if you extend the handler with custom logic. See the [LayerZero v2 Message Options](https://docs.layerzero.network/v2/developers/evm/protocol-gas-settings/options) documentation for the full encoding specification.
