---
sidebar_position: 21
title: Commitment Format
---

# Commitment Format

Milestone 3 moves data off the messaging layer. Instead of carrying a full payload
across the bridge, an intent carries a compact, fixed-size **commitment** that
references a Walrus blob and its storage terms. The commitment is the single wire
format shared by every chain and language in Bosphor, and it is the value the origin
chain later verifies the returned blob against.

This page is the reference for that format. It is implemented identically in
Solidity, Move, and TypeScript (Rust/Anchor is added with the Solana adapter) by a
single `CommitmentCodec`, and pinned byte for byte by shared parity vectors.

## Wire layout

A commitment is exactly **49 bytes**, big-endian, with no padding between fields:

| Offset | Field | Type | Bytes | Description |
|--------|-------|------|-------|-------------|
| 0 | `blobId` | bytes32 | 32 | Walrus blob identifier, computed client-side from the data |
| 32 | `size` | uint32 | 4 | Blob size in bytes |
| 36 | `encodingType` | uint8 | 1 | Walrus encoding type discriminant |
| 37 | `storageEpochs` | uint32 | 4 | Storage **duration** in Walrus epochs |
| 41 | `deadline` | uint64 | 8 | Intent deadline as a unix timestamp (seconds) |

```
blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
```

Storage is committed as a **duration** (`storageEpochs`), never as an absolute end
epoch. Origin chains do not know the current Walrus epoch, so an absolute end epoch
would not be verifiable at submission time. The Sui executor turns the duration into
an end-epoch check at execution: it asserts the certified blob's end epoch is at least
`current_epoch + storageEpochs`. The default `storageEpochs` matches the relayer's
`WALRUS_STORE_EPOCHS` (5).

## Intent identifier

The `intentId` binds a commitment to the origin sender and a per-sender nonce. It is
derived uniformly across chains with keccak256:

```
intentId = keccak256( commitment(49) ++ sender(32) ++ nonce(u64) )
```

- `sender` is left-padded with zero bytes to 32 bytes, so a 20-byte EVM address and a
  32-byte Sui or Solana address hash consistently.
- `nonce` is the sender's monotonic intent nonce as 8 big-endian bytes.

Solana uses this keccak value as the canonical intent id and stores intent state in a
PDA. It does not use the PDA address as the id.

## Single source of truth

The canonical parity vectors live at
`shared/parity/commitment-vectors.json`. They are generated from the TypeScript
reference codec and consumed by every implementation:

- **TypeScript** (`@bosphor/sdk`, `sdk/src/commitment-codec.ts`) reads the JSON directly.
- **Solidity** (`contracts/evm/src/CommitmentCodec.sol`) reads the same JSON in its Forge test.
- **Move** (`sui/lz-receiver/sources/commitment_codec.move`) is tested against a Move fixture generated from the same JSON.

CI regenerates the vectors on every run and fails if they drift from the reference
codec, so the three implementations can never silently diverge. Any change to the
layout or the `intentId` derivation is a cross-chain wire-format break and must be
made in the codec, regenerated, and re-verified everywhere at once.

## Example

The `canonical_evm` parity vector:

| Input | Value |
|-------|-------|
| `blobId` | `0xabab...ab` (32 bytes of `0xab`) |
| `size` | `1024` |
| `encodingType` | `1` |
| `storageEpochs` | `5` |
| `deadline` | `1760000000` |
| `sender` | `0x0011223344...00112233` (20-byte EVM address) |
| `nonce` | `7` |

Encodes to:

```
abababababababababababababababababababababababababababababababab0000040001000000050000000068e77800
```

and derives:

```
intentId = 0x70286217803b49a342aa1ad3de24977ea30ff17ab3654e2aa8957e1a9cf799c9
```
