---
sidebar_position: 4
---

# Sui Walrus Executor

The walrus executor module (`sui/executor/sources/walrus_executor.move`) handles the final step of a storage intent: verifying that data was stored on Walrus and recording the execution on-chain.

## Overview

After the relayer uploads a user's payload to Walrus and receives a certified blob, it calls `execute_store` on this module. The executor verifies the blob is certified, checks the deadline, prevents double-execution, and transfers both the blob and a `StorageReceipt` to the original sender.

## Module structure

```
sui/executor/
  Move.toml          # Package manifest (depends on Walrus)
  sources/
    walrus_executor.move   # Core executor logic
  tests/
    walrus_executor_tests.move
```

## ExecutorConfig

A shared object created at module initialization. Holds the authorized relayer address and a deduplication table.

| Field | Type | Description |
|-------|------|-------------|
| `relayer` | `address` | The only address allowed to call `execute_store` |
| `executed_intents` | `Table<vector<u8>, bool>` | Tracks which intent IDs have been executed |

The deployer is set as the initial relayer. Use `update_relayer` to change it.

## execute_store flow

```
Relayer calls execute_store(config, intent_id, blob, deadline_ms, clock, original_sender)
  1. Assert caller == config.relayer
  2. Assert blob.certified_epoch().is_some()   (Walrus certification check)
  3. Assert intent_id not in executed_intents   (deduplication)
  4. Assert clock.timestamp_ms() <= deadline_ms (deadline enforcement)
  5. Record intent_id in executed_intents
  6. Emit StorageExecuted event
  7. Create StorageReceipt
  8. Transfer blob to original_sender
  9. Transfer receipt to original_sender
```

## Blob verification

The executor does not trust the relayer's claim that data was stored. It checks `blob.certified_epoch().is_some()`, which is only true after Walrus storage nodes have certified the blob. A blob that has been uploaded but not yet certified will be rejected.

All blobs are stored as deletable (enforced at upload time in the relayer, not in the executor).

## StorageReceipt

An on-chain object transferred to the original sender as proof of execution.

| Field | Type | Description |
|-------|------|-------------|
| `intent_id` | `vector<u8>` | The 32-byte intent identifier |
| `walrus_blob_id` | `u256` | Content-addressed hash of the stored data |
| `end_epoch` | `u32` | Walrus epoch when the blob expires |
| `sender` | `address` | The original intent sender (mapped from EVM) |

## Events

**StorageExecuted**: Emitted on every successful execution. Contains `intent_id`, `walrus_blob_id`, `end_epoch`, and `executor` address.

**ConfigCreated**: Emitted once at module initialization with the config object ID and initial relayer address.

## Error codes

| Code | Constant | Meaning |
|------|----------|---------|
| 0 | `ENotRelayer` | Caller is not the authorized relayer |
| 1 | `EBlobNotCertified` | Blob has not been certified by Walrus |
| 2 | `EIntentAlreadyExecuted` | This intent ID was already executed |
| 3 | `EDeadlineExpired` | Current time exceeds the intent deadline |

## Trust assumptions

- The relayer is a trusted operator. Only the configured relayer address can call `execute_store`.
- Blob certification is verified on-chain. The executor does not blindly trust the relayer's claim.
- The `original_sender` address is provided by the relayer. In production, this comes from the ABI-decoded intent message received via LayerZero.
- Deadline enforcement uses Sui's on-chain clock, not the relayer's local time.

## Related

- [Architecture](architecture.md) for where the executor fits in the overall flow
- [Contract Interface](contract-interface.md) for the EVM side of the protocol
- [LayerZero Verification Flow](lz-verification-flow.md) for the cross-chain message path
