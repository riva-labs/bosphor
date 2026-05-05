---
sidebar_position: 5
title: Contract Interface Reference
---

# Contract Interface Reference

## BosphorAdapter.sol (EVM)

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

**Returns**: `intentId` -- deterministic hash of `(sender, dstEid, payload, nonce, deadline)`.

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

Confirm that an intent has been executed. Called by the trusted relayer.

```solidity
function confirmExecution(
    bytes32 _intentId,
    bytes calldata _proof
) external; // onlyRelayer
```

**Emits**: `IntentExecuted(intentId, proof)`

### executed

Check if an intent has been executed.

```solidity
function executed(bytes32 intentId) external view returns (bool);
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

## Sui Modules

### lz_receiver::IntentReceived

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

### walrus_executor::StorageExecuted

Emitted when `execute_store` records a Walrus blob.

```move
public struct StorageExecuted has copy, drop {
    intent_id: vector<u8>,   // 32 bytes
    walrus_blob_id: u256,    // Walrus blob identifier
    end_epoch: u32,          // Blob expiry epoch
    executor: address,       // Relayer address
}
```

## LZ Options

Default options for Sui delivery:

```
0x00030100110100000000000000000000000000030d40
```

This encodes: execution type 3 (lzReceive), gas limit 200,000.
