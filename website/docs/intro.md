---
slug: /
title: Introduction
---

# Bosphor

**Bosphor makes Walrus accessible from any chain.** Submit a storage intent on EVM, and Bosphor routes it cross-chain to Walrus on Sui, returning a DVN-verified proof back to your origin chain.

## What it does

1. **Submit**: Your EVM contract calls `submitIntent` with an arbitrary payload and a deadline.
2. **Route**: LayerZero v2 delivers the message cross-chain to Sui, verified by DVNs.
3. **Store**: The relayer uploads the payload to Walrus as a deletable blob.
4. **Prove**: An execution proof (blob ID, expiry epoch) returns to EVM via LayerZero, again DVN-verified.

Both legs of the round-trip are trustless. The relayer triggers execution but cannot forge proofs.

## Why Bosphor

EVM developers cannot use Walrus natively. Walrus lives on Sui, so storing data from Ethereum, Arbitrum, or any EVM chain requires bridging, transaction construction on Sui, and proof management across chains. Bosphor handles all of this behind a single Solidity function call.

Without Bosphor, an EVM developer would need to:

- Run a Sui wallet and manage SUI tokens
- Build and sign Sui transactions for Walrus blob uploads
- Implement their own cross-chain message verification
- Track storage proofs manually across two chains

With Bosphor, the developer calls `submitIntent` on EVM and receives a verified `IntentExecuted` event when the data is stored.

## Ecosystem

Bosphor connects three protocols:

- **[Walrus](https://www.walrus.xyz/)**: Decentralized storage on Sui. Bosphor stores intent payloads as Walrus blobs.
- **[LayerZero v2](https://layerzero.network/)**: Cross-chain messaging. Both message directions are DVN-verified.
- **[Sui](https://sui.io/)**: The execution layer where Walrus storage and proof generation happen.

## Current status

**Milestone 1 complete.** Deployed on Sepolia + Sui Testnet with verified bidirectional E2E flow.

Components shipped:

- EVM adapter contract with intent submission, fee quoting, and proof receipt
- Sui executor with Walrus blob storage and LayerZero proof return
- Two-step DVN-verified message flow (forward and return)
- NestJS relayer with health monitoring, deduplication, and retry logic
- E2E test suite and CI pipeline
- Documentation site

## Next steps

- [Quickstart](quickstart.md): Deploy and run the full pipeline in 15 minutes.
- [Architecture](architecture.md): Understand the system design and message flow.
- [Security Model](security-model.md): Review trust assumptions before integrating.
- [Contract Interface](contract-interface.md): Function signatures and code examples.
