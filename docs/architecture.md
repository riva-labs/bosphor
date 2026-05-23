# Bosphor Architecture

## System Overview

```
                    EVM (Sepolia)                           Sui (Testnet)
               ┌──────────────────┐                   ┌──────────────────┐
               │ BosphorAdapter   │                   │ lz_receiver      │
  User ───────>│ submitIntent()   │                   │ lz_receive()     │
               │                  │   abi.encode      │                  │
               │ _lzSend() ───────┼──(intentId,───────┼──> IntentReceived│
               │                  │   sender,         │      event       │
               │                  │   payload,        └────────┬─────────┘
               │                  │   deadline)                │
               │                  │                            │ Relayer
               │                  │                            ▼
               │                  │                   ┌──────────────────┐
               │                  │                   │ walrus_executor  │
               │                  │                   │ execute_store()  │
               │                  │                   │       │          │
               │                  │                   │       ▼          │
               │                  │                   │  Walrus blob     │
               │                  │                   │  (deletable)     │
               │                  │                   └────────┬─────────┘
               │                  │                            │ Relayer
               │                  │                   ┌────────┴─────────┐
               │                  │                   │ lz_send_proof()  │
               │ _lzReceive()  ◄──┼───────────────────┤ LZ type 1 msg   │
               │ IntentExecuted   │   {blobId,endEpoch}└──────────────────┘
               └──────────────────┘
```

### Message Flow

1. **EVM -> Sui** (LayerZero): `submitIntent` encodes `(intentId, sender, payload, deadline)` via `abi.encode` and sends through LayerZero v2 OApp messaging.
2. **Sui lz_receive**: LZ executor builds a PTB using `ptb_builder::build_lz_receive_ptb`, calls `lz_receiver::lz_receive` which validates peer + endpoint and emits `IntentReceived`.
3. **Relayer**: Polls `IntentReceived` events on Sui, uploads payload to Walrus, calls `execute_store`.
4. **Sui -> EVM** (LayerZero): Relayer calls `lz_send_proof` on Sui, which sends a type 1 message via LayerZero back to EVM. The EVM `_lzReceive` decodes `(intentId, blobId, endEpoch)` and marks the intent as executed.

## EVM Adapter Contract (BosphorAdapter.sol)

### Interface

| Function | Access | Description |
|----------|--------|-------------|
| `submitIntent(dstEid, payload, deadline, options)` | external payable | Submit storage intent via LayerZero |
| `quote(dstEid, payload, deadline, options)` | view | Estimate LayerZero fee |
| `confirmExecution(intentId, proof)` | onlyOwner | Emergency fallback to confirm execution |
| `_lzReceive(origin, guid, message, executor, extraData)` | internal (LZ) | Primary proof path: type 1 message with (intentId, blobId, endEpoch) |
| `setRelayer(relayer)` | onlyOwner | Update trusted relayer |
| `getIntentId(sender, chainId, payload, nonce, deadline)` | pure | Compute intent ID |

### Events

- `IntentSubmitted(intentId, sender, targetChainId, payload, nonce, deadline)` — emitted on submit
- `IntentExecuted(intentId, proof)` — emitted on confirmed execution
- `RelayerUpdated(oldRelayer, newRelayer)` — emitted on relayer change

### Intent ID Computation

```
intentId = keccak256(abi.encodePacked(sender, uint64(dstEid), payload, nonce, deadline))
```

Nonce is per-sender, auto-incremented. Deadline is a Unix timestamp; expired intents revert.

### Trust Boundary

- **Trustless**: Intent registration, nonce enforcement, deadline checks, LZ message delivery (DVN-verified)
- **Trusted**: Relayer triggers `lz_send_proof` on Sui, but proof delivery is DVN-verified via LayerZero. `confirmExecution` is owner-only emergency fallback.

## Sui Walrus Executor

### lz_receiver.move

Receives cross-chain messages from EVM via LayerZero v2 executor.

- `lz_receive(config, oapp, call, ctx)`: Validates LZ Call hot-potato, extracts intent ID from ABI-encoded message (first 32 bytes), records in `received_intents` table, emits `IntentReceived`.
- `register_oapp(config, oapp, endpoint, info, ctx)`: Entry function that registers the OApp with the LZ endpoint using the internal CallCap.
- `is_received(config, intent_id)`: View function to check if an intent was received.

### walrus_executor.move

Executes storage operations on Walrus.

- `execute_store(config, intent_id, blob, deadline_ms, clock, sender, ctx)`: Accepts a certified Walrus `Blob` object, verifies certification, checks deadline, records execution, emits `StorageExecuted`, transfers blob and receipt to original sender.
- All blobs are stored as **deletable** per project policy.

### ptb_builder.move

Generates PTB metadata for the LZ executor.

- `lz_receive_info(config, oapp)`: Returns `OAppInfoV1`-encoded bytes containing the PTB construction instructions. The executor uses this to dynamically build `lz_receive` transactions.
- `build_lz_receive_ptb(config, oapp, call)`: Called by the executor during simulation to produce the actual `MoveCall` vector for `lz_receive`.

**Critical**: `lz_receive_info` must return `OAppInfoV1`-formatted bytes (not raw MoveCall bytes). The LZ executor deserializes the response as `OAppInfoV1 { oapp_object, next_nonce_info, lz_receive_info, extra_info }`.

## LayerZero Proof Pipeline

### EVM -> Sui (Forward Path)

1. `submitIntent` calls `_lzSend` with 4-field ABI-encoded message
2. LayerZero DVN (LayerZero Labs) verifies the message on Sui endpoint
3. Confirmation depth: 2 blocks
4. LZ executor reads `OAppInfoV1` from endpoint registry, builds PTB, executes `lz_receive`

### Sui -> EVM (Return Path)

Bidirectional LZ proof path:
1. Relayer observes `IntentReceived` event on Sui
2. Uploads payload to Walrus (deletable blob)
3. Calls `execute_store` on Sui
4. Calls `lz_send_proof` on Sui, which sends a type 1 message via LayerZero
5. EVM `_lzReceive` decodes `(intentId, blobId, endEpoch)` and marks intent as executed

Wire format: `bytes1(0x01) ++ abi.encode(intentId, blobId, endEpoch)`

Emergency fallback: owner can call `confirmExecution` directly on EVM.

### OAppInfoV1 Registration

The OApp must register with the LZ endpoint using `OAppInfoV1::encode()` format:

```
[version: u16 = 1][BCS(OAppInfoV1 {
    oapp_object: address,
    next_nonce_info: vector<u8>,
    lz_receive_info: vector<u8>,
    extra_info: vector<u8>,
})]
```

Where `lz_receive_info` itself contains:
```
[version: u16 = 1][BCS(vector<MoveCall>)]
```

## Known Limitations

| Limitation | Severity | Resolution Plan |
|-----------|----------|-----------------|
| Relayer is centralized (trusted operator) | Medium | Permissionless relayer auction (Milestone 4) |
| No origin-chain payment flow | Medium | Escrow-based payment (Milestone 4) |
| Sui testnet only | Low | Mainnet after Milestone 2 |
| Single DVN (LZ Labs) | Low | Multi-DVN in hardening phase |
| Relayer triggers return path | Low | Permissionless relayer auction (Milestone 4) |
