---
sidebar_position: 5
title: Contract Interface Reference
---

# Contract Interface Reference

## IBosphorAdapter (Interface)

Integrators should import `IBosphorAdapter.sol` from `contracts/evm/src/interfaces/` rather than the full `BosphorAdapter.sol`. The interface includes all external function signatures, events, errors, and structs needed for integration.

```solidity
import { IBosphorAdapter } from "./interfaces/IBosphorAdapter.sol";
```

## BosphorAdapter.sol (EVM)

`BosphorAdapter` implements `IBosphorAdapter` and extends the LayerZero `OApp`.

### submitIntent

Submit a storage intent to be routed to Walrus via LayerZero.

```solidity
function submitIntent(
    uint32 _dstEid,
    bytes calldata _payload,
    uint256 _deadline,
    bytes calldata _options
) external payable returns (bytes32 intentId);
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `_dstEid` | uint32 | Destination chain EID. Sui testnet: `40378` |
| `_payload` | bytes | Arbitrary data to store on Walrus |
| `_deadline` | uint256 | Unix timestamp after which the intent expires |
| `_options` | bytes | LayerZero execution options (gas limit, etc.) |

**Returns**: `intentId`, a deterministic hash of `(sender, dstEid, payload, nonce, deadline)`.

**Emits**: `IntentSubmitted(intentId, sender, targetChainId, payload, nonce, deadline)`

### quote

Estimate the LayerZero fee for submitting an intent.

```solidity
function quote(
    uint32 _dstEid,
    bytes calldata _payload,
    uint256 _deadline,
    bytes calldata _options
) external view returns (MessagingFee memory);
```

**Returns**: `MessagingFee { nativeFee, lzTokenFee }` -- pass `nativeFee` as `msg.value` to `submitIntent`.

### confirmExecution

Emergency fallback to manually confirm intent execution. Owner-only, for disaster recovery.
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

**Type 1 (execution proof):** Remaining bytes are ABI-encoded as `(bytes32 intentId, bytes32 blobId, uint256 endEpoch)`. The intent is marked as executed and `IntentExecuted` is emitted with `abi.encode(blobId, endEpoch)` as proof.

Wire format: `bytes1(0x01) ++ abi.encode(intentId, blobId, endEpoch)`

### setRelayer

Update the trusted relayer address. Owner-only.

```solidity
function setRelayer(address _relayer) external; // onlyOwner
```

**Emits**: `RelayerUpdated(oldRelayer, newRelayer)`

### getIntentId

Compute the deterministic intent ID for a given set of parameters.

```solidity
function getIntentId(
    address _sender,
    uint64 _targetChainId,
    bytes calldata _payload,
    uint256 _nonce,
    uint256 _deadline
) external pure returns (bytes32);
```

### View Functions

```solidity
function trustedRelayer() external view returns (address);
function intents(bytes32 intentId) external view returns (bool);
function executed(bytes32 intentId) external view returns (bool);
function intentDeadlines(bytes32 intentId) external view returns (uint256);
function nonces(address sender) external view returns (uint256);
```

### Errors

```solidity
error DeadlineExpired();
error IntentAlreadyExists();
error IntentNotFound();
error AlreadyExecuted();
error ZeroAddress();
error UnknownMessageType();
```

## Events

```solidity
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
```

## Usage Examples (ethers.js)

### Submit an intent

```typescript
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const adapter = new ethers.Contract(
  ADAPTER_ADDRESS,
  [
    "function quote(uint32,bytes,uint256,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
    "function submitIntent(uint32,bytes,uint256,bytes) payable returns (bytes32)",
    "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)",
  ],
  signer
);

const dstEid = 40378; // Sui testnet
const payload = ethers.toUtf8Bytes("Hello Walrus");
const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
const options = "0x00030100110100000000000000000000000000030d40";

// Get fee estimate
const fee = await adapter.quote(dstEid, payload, deadline, options);

// Submit intent
const tx = await adapter.submitIntent(dstEid, payload, deadline, options, {
  value: fee.nativeFee,
});
const receipt = await tx.wait();
console.log("Intent submitted:", receipt.hash);
```

### Listen for events

```typescript
// Listen for new intents
adapter.on("IntentSubmitted", (intentId, sender, targetChainId, payload, nonce, deadline) => {
  console.log("New intent:", intentId);
  console.log("Sender:", sender);
  console.log("Payload:", ethers.toUtf8String(payload));
});

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

The relayer calls `execute_store` after uploading the payload to Walrus and receiving a certified blob.

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
    tx.object(EXECUTOR_CONFIG_ID),
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
  const { intent_id, src_eid, nonce } = event.parsedJson as {
    intent_id: number[];
    src_eid: number;
    nonce: string;
  };
  console.log("Intent:", Buffer.from(intent_id).toString("hex"));
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

Message format from EVM (`abi.encode`):

| Offset | Length | Field |
|--------|--------|-------|
| 0:32 | 32 | intentId (bytes32) |
| 32:64 | 32 | sender (address, left-padded) |
| 64:96 | 32 | offset to payload data |
| 96:128 | 32 | deadline (uint256) |
| 128:160 | 32 | payload length |
| 160:... | variable | payload data |

**Aborts**: `EInvalidMessageLength` (1) if message < 32 bytes, `EIntentAlreadyReceived` (0) if duplicate.

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

**Aborts**: `EUnauthorizedRelayer` (2) if caller is not the relayer, `EIntentNotReceived` (6) if intent not recorded.

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

**Aborts**: `EZeroAddress` (5) if `new_relayer` is `@0x0`.

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
    payload: vector<u8>,     // Full ABI-encoded message
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
| 1 | `EInvalidMessageLength` | Message payload shorter than 32 bytes |
| 2 | `EUnauthorizedRelayer` | Caller is not the authorized relayer |
| 3 | `EInvalidIntentIdLength` | intent_id must be exactly 32 bytes |
| 4 | `EInvalidBlobIdLength` | blob_id must be exactly 32 bytes |
| 5 | `EZeroAddress` | Relayer address must not be zero |
| 6 | `EIntentNotReceived` | Intent must exist before sending proof |

### walrus_executor

#### execute_store

Accepts a certified Walrus `Blob` object, verifies certification, checks deadline, records execution, emits `StorageExecuted`, and transfers blob and receipt to the original sender. Relayer-only.

```move
entry fun execute_store(
    config: &mut ExecutorConfig,
    intent_id: vector<u8>,
    blob: Blob,
    deadline_ms: u64,
    clock: &Clock,
    sender: address,
    ctx: &mut TxContext,
)
```

**Aborts**: `ENotRelayer` (0), `EBlobNotCertified` (1), `EIntentAlreadyExecuted` (2), `EDeadlineExpired` (3).

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

`abi.encode(intentId, sender, payload, deadline)` sent via `_lzSend`.

### Step 2: Proof Verification (Sui to EVM)

Type 1 proof message: `bytes1(0x01) ++ abi.encode(intentId, blobId, endEpoch)`

Total: 97 bytes (1 type byte + 32 intentId + 32 blobId + 32 endEpoch).

## LZ Options

Default options for Sui delivery:

```
0x00030100110100000000000000000000000000030d40
```

This encodes: execution type 3 (lzReceive), gas limit 200,000.
