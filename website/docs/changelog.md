---
title: Changelog
---

# Changelog

## v0.1.0, Milestone 1: Cross-Chain Execution Core

The initial release establishing the complete cross-chain storage intent pipeline from EVM to Walrus and back.

### Added

- **EVM Adapter** (`BosphorAdapter.sol`): Solidity contract on Sepolia for submitting storage intents via LayerZero v2. Includes fee quoting, deadline enforcement, nonce-based intent IDs, and owner-only emergency `confirmExecution`. See [Contract Interface](contract-interface.md).

- **Sui Walrus Executor** (`lz_receiver`, `walrus_executor`, `ptb_builder`): Move package on Sui testnet that receives cross-chain intents, executes Walrus blob storage, and sends DVN-verified proofs back to EVM. See [Sui Executor](sui-executor.md).

- **Two-step LayerZero verification**: Both legs of the message flow (intent delivery EVM to Sui, proof return Sui to EVM) are verified by LayerZero DVNs. See [LZ Verification Flow](lz-verification-flow.md).

- **Relayer service**: NestJS service that bridges Sui and EVM. Polls for events, uploads payloads to Walrus, executes storage, and sends proofs. Includes health monitoring, TTL-based deduplication, fee quoting with 10% buffer, and retry logic. See [Relayer](relayer.md).

- **E2E test suite**: Full round-trip test that submits an intent on Sepolia, waits for LayerZero delivery to Sui, and confirms proof receipt back on EVM. See [Testing](testing.md).

- **CI pipeline**: Automated testing on every push: Forge tests, Move tests, and relayer build and unit tests.

- **Documentation site**: Docusaurus-powered docs with architecture guides, contract reference, deployment instructions, and operator guides.

### Deployed contracts (testnet)

| Component | Address |
|-----------|---------|
| BosphorAdapter (Sepolia) | `0xbC7EF2F021F517d871282C2bb512C741ad2958c3` |
| Sui Package | `0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656` |
| Sui OApp Object | `0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0` |

### Key technical decisions

- **OAppInfoV1 format**: `lz_receive_info` must be wrapped in `OAppInfoV1::encode()`, not returned as raw MoveCall bytes. This was the critical fix in v5.
- **Deletable blobs**: All Walrus blobs are stored as deletable per project policy.
- **OpenZeppelin v4.9.6**: LayerZero v2 OApp requires OZ v4, not v5, due to `msg.sender`-based `Ownable`.
- **Node.js 22**: Required for `tsx` and `@mysten/sui` compatibility.
