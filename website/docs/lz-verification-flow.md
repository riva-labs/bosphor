---
sidebar_position: 5
---

# LayerZero Two-Step Verification Flow

Bosphor uses LayerZero v2 for both directions of its cross-chain protocol. This page describes the message flow, encoding formats, and trust boundaries.

## Overview

The protocol has two verified message paths:

1. **Forward path (EVM to Sui):** User submits an intent on EVM, LayerZero DVN verifies and delivers it to Sui.
2. **Return path (Sui to EVM):** After execution, the relayer sends a proof back through LayerZero to confirm on EVM.

Both paths are independently verified by LayerZero's Decentralized Verifier Network (DVN).

## Forward path: EVM to Sui

```
User                    EVM                     LayerZero DVN           Sui
  |                      |                          |                    |
  |-- submitIntent() --> |                          |                    |
  |                      |-- _lzSend(message) ----> |                    |
  |                      |                          |-- lz_receive() --> |
  |                      |                          |                    |-- emit IntentReceived
```

### Step by step

1. User calls `submitIntent(payload, deadline)` on the `BosphorAdapter` contract (Sepolia).
2. The adapter ABI-encodes the message: `(bytes32 intentId, address sender, bytes payload, uint256 deadline)`.
3. The message is prefixed with type byte `0x00` and sent via `_lzSend()` to LayerZero.
4. LayerZero's DVN verifies the message and delivers it to the Sui endpoint.
5. The LZ executor calls `lz_receive` on the Bosphor OApp on Sui.
6. The OApp decodes the message, stores an `IntentRecord`, and emits an `IntentReceived` event.

### Message format (type 0, forward)

```
[0x00] [intentId (32 bytes)] [sender (32 bytes, left-padded address)]
       [payload (dynamic)]   [deadline (32 bytes, uint256)]
```

Total: 1 + 32 + 32 + len(payload) + 32 bytes.

## Return path: Sui to EVM

```
Relayer                 Sui                     LayerZero DVN           EVM
  |                      |                          |                    |
  |-- lz_send_proof() -> |                          |                    |
  |                      |-- PTB via LZ endpoint -> |                    |
  |                      |                          |-- _lzReceive() --> |
  |                      |                          |                    |-- mark executed
```

### Step by step

1. The relayer uploads data to Walrus and calls `execute_store` on Sui.
2. The relayer calls `lz_send_proof()` on the Bosphor OApp, passing the intent ID, blob ID, end epoch, and destination EID.
3. The function builds a type-1 proof message and initiates a LayerZero send via a Programmable Transaction Block (PTB).
4. The PTB routes through the LZ endpoint, ULN302, executor fee lib, DVN fee lib, and treasury.
5. `confirm_lz_send_proof()` finalizes the send, handles coin refunds, and emits a `ProofSent` event.
6. LayerZero's DVN verifies the proof message and delivers it to the EVM endpoint.
7. The `BosphorAdapter._lzReceive()` on EVM decodes the type-1 message and marks the intent as executed.

### Message format (type 1, proof)

```
[0x01] [intentId (32 bytes)] [blobId (32 bytes)] [endEpoch (32 bytes, uint256)]
```

Total: 97 bytes. The EVM `_lzReceive` decoder matches on the `0x01` prefix.

## OAppInfoV1 format

When registering the OApp with the LayerZero endpoint on Sui, the `ptb_builder` module generates execution metadata in OAppInfoV1 format:

```
[version byte] [BCS-encoded: (address, vec<u8>, vec<u8>, vec<u8>)]
```

This tells the LZ executor how to build the PTB that delivers messages to this OApp. The executor replays the MoveCall sequence in the actual `lz_receive` transaction.

This was a key fix in v5: `lz_receive_info` was initially returning raw MoveCall bytes, but the LZ executor expects OAppInfoV1 format wrapped via `oapp_info_v1::create().encode()`.

## PTB structure (Sui LZ send)

The return path requires a 16-step PTB to route through all LZ infrastructure contracts:

| Step | Operation |
|------|-----------|
| 0 | `lz_receiver::lz_send_proof` (build message, initiate send) |
| 1 | `endpoint_v2::send` |
| 2 | `uln_302::send` |
| 3 | `executor_fee_lib::quote_executor` |
| 4 | `uln_302::quote_worker_fee` (executor) |
| 5 | `dvn_fee_lib::quote_dvn` |
| 6 | `uln_302::quote_worker_fee` (DVN) |
| 7 | `price_feed::get_fee` |
| 8 | `dvn_fee_lib::quote_dvn` (second DVN) |
| 9 | `uln_302::quote_worker_fee` (second DVN) |
| 10 | `price_feed::get_fee` (second) |
| 11 | `uln_302::confirm_quote` |
| 12 | `treasury::pay_fee` |
| 13 | `endpoint_v2::confirm_send` |
| 14 | `lz_receiver::confirm_lz_send_proof` |

A similar PTB structure is used for fee quoting (`quote_proof` / `confirm_quote_proof`).

## Trust boundaries

| Boundary | Trust model |
|----------|-------------|
| EVM to LZ | User trusts LayerZero DVN to deliver the message faithfully |
| LZ to Sui | Sui OApp verifies the message came from the LZ endpoint |
| Relayer | Trusted operator. Only the configured relayer can trigger `lz_send_proof` and `execute_store` |
| Sui to LZ | Relayer initiates the send, DVN verifies independently |
| LZ to EVM | EVM adapter verifies the message came from the configured Sui peer via LZ |
| Walrus | Blob certification is verified on-chain before execution |

The DVN provides independent verification in both directions. The relayer cannot forge messages that bypass DVN verification.

## Fee handling

The relayer pays LZ messaging fees in SUI. Before sending a proof, the relayer calls `quoteLzFee` to estimate the cost, then adds a 10% buffer. After the send, any unused SUI is refunded to the relayer's address.

## Related

- [Architecture](architecture.md) for the system overview
- [Sui Executor](sui-executor.md) for the Walrus execution step
- [Contract Interface](contract-interface.md) for EVM function signatures
- [Relayer](relayer.md) for the operator that drives both paths
