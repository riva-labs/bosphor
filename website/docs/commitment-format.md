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
Solidity, Move, TypeScript, and Rust by a single `CommitmentCodec`, and pinned byte
for byte by shared parity vectors.

## Wire layout

A commitment is exactly **50 bytes**, big-endian, with no padding between fields.
The current format version is **1**:

| Offset | Field | Type | Bytes | Description |
|--------|-------|------|-------|-------------|
| 0 | `version` | uint8 | 1 | Wire-format version, currently `1` |
| 1 | `blobId` | bytes32 | 32 | Walrus blob identifier, computed client-side from the data |
| 33 | `size` | uint32 | 4 | Blob size in bytes |
| 37 | `encodingType` | uint8 | 1 | Walrus encoding type discriminant |
| 38 | `storageEpochs` | uint32 | 4 | Storage **duration** in Walrus epochs |
| 42 | `deadline` | uint64 | 8 | Intent deadline as a unix timestamp (seconds) |

```
version(u8=1) ++ blobId(32) ++ size(u32) ++ encodingType(u8) ++ storageEpochs(u32) ++ deadline(u64)
```

The leading version byte lets the format evolve without coordinated redeploys.
Every decoder checks it first and fails loudly on a version it does not
understand: the Solidity library reverts with `UnsupportedCommitmentVersion`,
the Move module aborts with `EUnsupportedCommitmentVersion`, the SDK throws the
typed `UnsupportedCommitmentVersionError`, and the Rust crate returns
`DecodeError::UnsupportedVersion`. A mixed-version deployment therefore fails
explicitly instead of mis-deriving intent ids.

Storage is committed as a **duration** (`storageEpochs`), never as an absolute end
epoch. Origin chains do not know the current Walrus epoch, so an absolute end epoch
would not be verifiable at submission time. The Sui executor turns the duration into
an end-epoch check at execution: it asserts the certified blob's end epoch is at least
`current_epoch + storageEpochs`. The default `storageEpochs` matches the relayer's
`WALRUS_STORE_EPOCHS` (5).

## Intent identifier

The `intentId` binds a commitment to the origin sender and a per-sender nonce. It is
derived uniformly across chains with keccak256 over the versioned commitment
bytes:

```
intentId = keccak256( commitment(50) ++ sender(32) ++ nonce(u64) )
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
- **Move** (`contracts/sui/lz-receiver/sources/commitment_codec.move`) is tested against a Move fixture generated from the same JSON.
- **Rust** (`contracts/solana/commitment-codec`, the reference for the Solana adapter) is tested against a Rust fixture generated from the same JSON.

CI regenerates the vectors on every run and fails if they drift from the reference
codec, so the four implementations can never silently diverge. The vectors also
carry negative fixtures (full-length commitments with version bytes `0` and `2`)
that every implementation must reject. Any change to the layout or the `intentId`
derivation is a cross-chain wire-format break, bumps the version byte, and must be
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

Encodes to (note the leading version byte `01`):

```
01abababababababababababababababababababababababababababababababab0000040001000000050000000068e77800
```

and derives:

```
intentId = 0x7827b0f7e14c906b545f8bc961cc4ccad1f73ba2b68461b12df0a49fa8f6bb25
```
