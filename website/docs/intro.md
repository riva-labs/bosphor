---
slug: /
sidebar_position: 1
title: Introduction
---

# Bosphor

Cross-chain storage intent routing for Walrus.

Bosphor lets any EVM chain submit storage intents that are executed on
Walrus (Sui) via LayerZero v2, with verifiable proof returned to the
origin chain.

## What it does

1. **Submit**: EVM contract receives a storage intent with arbitrary payload
2. **Route**: LayerZero v2 delivers the message cross-chain to Sui
3. **Store**: Relayer uploads the payload to Walrus as a deletable blob
4. **Prove**: Execution proof (blob ID, expiry epoch) returns to EVM via LayerZero

The full round-trip is trustless end-to-end: both the forward path (EVM to Sui) and the return path (Sui to EVM) are verified by LayerZero DVNs. The relayer triggers execution but cannot forge proofs.

## Current status

**Milestone 1 complete.** Deployed on Sepolia + Sui Testnet with verified bidirectional E2E flow.

Features shipped:
- Bidirectional LayerZero messaging (forward intents + return proofs)
- Walrus blob storage with on-chain execution receipts
- LZ fee quoting on the return path (Sui `quote_proof` + relayer 10% buffer)
- TTL-based deduplication pruning in the relayer
- Health monitoring endpoint (`GET /health`)
- CI pipeline (Forge tests, Move tests, relayer build + unit tests)
- Two-step E2E verification (forward delivery + return proof receipt)

See the [Architecture](architecture.md) page for the full message flow, or [Relayer](relayer.md) for operator setup.
