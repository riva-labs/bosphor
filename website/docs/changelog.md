---
title: Changelog
---

# Changelog

## Milestone 4: Payment Flow & Integration Hardening

Storing becomes a paid operation: the relayer stops fronting the Walrus cost, and
users escrow payment on the origin chain, released by the trustless LayerZero
proof.

### Added

- **Origin-chain payment flow**: the EVM `BosphorEscrowAdapter` and a Solana
  escrow vault escrow the user's payment at submit, release it to the relayer on
  a genuine proof, and refund the payer after a deadline. See [Payment flow](payment-flow.md)
  and the [contract interface](contract-interface.md).

- **Off-chain quoting**: a relayer `POST /quote` endpoint and the SDK
  `client.storePriced()` / `priceQuote()` surface a single all-in origin-native
  amount plus a USD breakdown, priced from a multi-source oracle (Pyth Hermes +
  CoinGecko) with staleness and sanity bounds. See [Public API](public-api.md).

- **Never lose money**: a relayer break-even guard recomputes cost at live prices
  before any WAL spend and skips unprofitable intents (which then refund), with a
  per-intent profit-and-loss ledger and a negative-margin alert.

- **Sub-3s processing + benchmarks**: an event-driven store-queue drain and a
  benchmark harness reporting p50/p95/p99 relayer processing latency (distinct
  from the LayerZero round-trip).

- **USDC/CCTP scaffolding**: an opt-in USDC deposit via a Permit2 witness bound to
  the intent id, with CCTP settlement scaffolding behind mocks (live wiring is a
  fast-follow).

## v0.2.0, Milestone 2: Proof Validation & System Stabilization

Operational hardening of the cross-chain pipeline: live monitoring, continuous validation, a public data surface, and resilience improvements.

### Added

- **Monitoring stack**: Prometheus metrics and Grafana dashboards across the relayer and canary, plus a self-hosted Kener status page at status.bosphor.xyz. See [Relayer](relayer.md) and [Canary Monitoring](canary.md).

- **Continuous canary**: A standalone service that runs real synthetic end-to-end round-trips on a fixed interval, submitting an intent on EVM and confirming the proof returns. It is the primary signal that the whole cross-chain path is healthy. See [Canary Monitoring](canary.md).

- **Per-intent lifecycle store + public feed API**: The relayer records each intent's lifecycle and exposes a read-only `GET /public/intents` feed at api.bosphor.xyz. See [Public API](public-api.md).

- **Sentry error tracking**: The relayer and canary report runtime errors and failed probes to Sentry when `SENTRY_DSN` is configured.

- **Chaos harness**: An on-demand harness for exercising the relayer's resilience under injected failures. See [Chaos Harness](chaos-harness.md).

- **Self-operated LayerZero DVN**: After a sui-testnet DVN outage, Bosphor now operates its own LayerZero DVN, so the cross-chain path no longer relies on a single third-party DVN. The full cross-chain round-trip was validated on Ethereum mainnet.

### Changed

- **Relayer stabilization**: Reliability fixes for checkpoint handling, network-aware WAL coin type resolution, and consecutive Sui transaction sequencing.

### Deployed contracts (testnet, current)

| Component | Address |
|-----------|---------|
| BosphorAdapter (Sepolia) | `0x3c8B7A1c684dD10aEd6Bb392651c678f1CE05E10` |
| Sui Package | `0x169f0ece587a5b54cf39218cdf5319ba7ecbb7d403b022802f1f329dbee3e596` |
| Sui OApp Object | `0x4a5bf89e083c16bd8034b027454057d30ec336c734a7cc274e857a9125540026` |

LZ Endpoint (Sepolia): `0x6EDCE65403992e310A62460808c4b910D972f10f` (EID 40161). Sui testnet EID: 40378.

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

> Note: these are the v0.1.0-era addresses. They have since been superseded by the v0.2.0 addresses listed above. Use the v0.2.0 addresses for all current integration.

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
