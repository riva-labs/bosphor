# CLAUDE.md — Bosphor Project Context

> Claude Code: Read this file completely at the start of every session.
> This is the single source of truth for architecture, conventions, and current state.

---

## What Is Bosphor?

Bosphor is a **Storage Intent Router for Walrus** — it enables any blockchain (EVM, Solana) to use
Walrus decentralized storage as a native feature through a secure intent → relay → execution → proof flow.

**Core value**: Permanence portable. Any chain can STORE / DELETE / EXTEND blobs on Walrus with
cryptographic guarantees, without needing to understand Sui.

---

## Architecture Overview

```
[Origin Chain (EVM/Solana)]
        │
        │  1. User submits StorageIntent (signed, with nonce + deadline)
        ▼
[BosphorAdapter Contract]  ←── LayerZero v2 ──→  [Sui Executor Module]
        │                                                  │
        │  2. LayerZero routes message                     │  3. Execute on Walrus
        │                                                  ▼
        │                                        [Walrus Storage Layer]
        │                                                  │
        │  4. Proof emitted back via LayerZero             │
        ◄─────────────────────────────────────────────────
        │
        │  5. Receipt confirmed on origin chain
        ▼
[Origin Chain — StorageReceipt event]
```

**BlobGuard** (Sui shared object): Owns blob lifecycle. All STORE/DELETE/EXTEND ops go through it.
Enforces origin-chain authorization, nonce replay protection, deadline enforcement.

**Seal Integration** (Phase 9): Client-side encryption layer on top of existing flows.
Plaintext never touches relayer.

---

## Monorepo Structure

```
bosphor/
├── packages/
│   ├── contracts-evm/       # Solidity + Foundry — BosphorAdapter, LayerZero integration
│   ├── contracts-sui/       # Move — WalrusExecutor, BlobGuard shared object
│   ├── contracts-solana/    # Rust + Anchor — Solana adapter (Phase 6)
│   ├── relayer/             # Node.js/TypeScript — event-driven relay service
│   ├── sdk/                 # TypeScript — chain-agnostic unified SDK
│   └── dashboard/           # Next.js — internal dev portal
├── infra/
│   ├── docker/              # Compose files for local + staging
│   └── monitoring/          # Prometheus + Grafana configs
├── docs/
│   ├── decisions/           # ADRs — architecture decision records
│   └── api/                 # API documentation
├── tests/
│   ├── e2e/                 # Cross-chain end-to-end tests
│   └── integration/         # Component integration tests
└── .github/workflows/       # CI/CD pipelines
```

---

## Package Responsibilities

### `packages/contracts-evm`
- **Language**: Solidity ^0.8.24
- **Toolchain**: Foundry (forge, cast, anvil)
- **Key contracts**:
  - `BosphorAdapter.sol` — receives user intents, sends via LayerZero
  - `StorageIntent.sol` — intent struct and validation
  - `ProofVerifier.sol` — verifies Sui execution proofs
- **Test command**: `forge test -vvv`
- **Deploy command**: `forge script script/Deploy.s.sol --broadcast`

### `packages/contracts-sui`
- **Language**: Move
- **Toolchain**: Sui CLI
- **Key modules**:
  - `walrus_executor.move` — executes STORE/DELETE/EXTEND on Walrus
  - `blob_guard.move` — shared object, lifecycle controller
  - `intent_verifier.move` — verifies origin-chain signatures
  - `nonce_registry.move` — replay protection
- **Test command**: `sui move test`
- **Deploy command**: `sui client publish --gas-budget 100000000`

### `packages/relayer`
- **Language**: TypeScript (Node.js 20, ESM)
- **Framework**: Express + ethers.js + @mysten/sui
- **Pattern**: Event-driven, listens to origin chain events → routes to Sui
- **Key files**:
  - `src/handlers/intentHandler.ts` — processes StorageIntent events
  - `src/services/suiExecutor.ts` — submits txs to Sui
  - `src/services/layerzero.ts` — LayerZero message handling
  - `src/utils/nonce.ts` — nonce management
- **Test command**: `pnpm test`
- **Dev command**: `pnpm dev` (tsx watch)

### `packages/sdk`
- **Language**: TypeScript (ESM, tree-shakeable)
- **Exports**: `@bosphor/sdk/evm`, `@bosphor/sdk/sui`, `@bosphor/sdk/solana`, `@bosphor/sdk/core`
- **Key classes**:
  - `BosphorClient` — unified entry point
  - `IntentBuilder` — chain-agnostic intent construction
  - `ProofWatcher` — async receipt polling
- **Test command**: `pnpm test`
- **Build command**: `pnpm build`

### `packages/dashboard`
- **Framework**: Next.js 14 (App Router, TypeScript)
- **Purpose**: Internal dev portal — tx explorer, relay monitoring, test UI
- **Dev command**: `pnpm dev`

---

## Key Data Structures

### StorageIntent (canonical)
```typescript
interface StorageIntent {
  originChain: ChainId;          // e.g. "evm:11155111" (Sepolia)
  sender: string;                // origin chain address (hex)
  action: "STORE" | "DELETE" | "EXTEND";
  blobId?: string;               // required for DELETE/EXTEND
  payload?: Uint8Array;          // required for STORE (the data)
  epochsAhead?: number;          // for STORE/EXTEND
  nonce: bigint;                 // replay protection
  deadline: number;              // unix timestamp
  signature: string;             // origin chain signature
}
```

### StorageReceipt (proof)
```typescript
interface StorageReceipt {
  intentHash: string;
  blobId: string;
  suiTxDigest: string;
  walrusEpoch: number;
  timestamp: number;
  relayerAddress: string;
}
```

---

## Conventions

### TypeScript
- ESM modules only (`"type": "module"` in package.json)
- No `any` — use `unknown` and narrow
- Error handling: `Result<T, E>` pattern (no untyped throws across module boundaries)
- All async functions must handle errors explicitly

### Solidity
- Follow Checks-Effects-Interactions
- Events for all state changes
- Custom errors (not revert strings)
- NatSpec on all public functions

### Move (Sui)
- Capability objects for admin actions
- Shared objects require careful concurrency reasoning — document every `shared_object_mut`
- Use `assert!` with descriptive error constants (not magic numbers)

### Git
- Branch naming: `phase/1-evm-adapter`, `feat/blob-guard`, `fix/nonce-collision`
- Commit format: `type(scope): description` — e.g. `feat(contracts-evm): add StorageIntent validation`
- PRs require passing CI before merge

---

## Current Phase & Status

**CURRENT PHASE**: Phase 1 — Cross-Chain Execution Core
**STATUS**: 🟡 Setup / Scaffolding

### Phase 1 Checklist
- [ ] EVM BosphorAdapter contract (LayerZero OApp pattern)
- [ ] Sui WalrusExecutor module (STORE only)
- [ ] LayerZero bidirectional proof flow
- [ ] Relayer skeleton (event listener → Sui submitter)
- [ ] Docker Compose for local dev
- [ ] CI pipeline (GitHub Actions)

### Phase History
| Phase | Status | Notes |
|-------|--------|-------|
| 1 | 🟡 In Progress | EVM adapter + Sui executor |
| 2-9 | ⬜ Not started | — |

---

## Environment Setup

### Prerequisites
```bash
node >= 20, pnpm >= 9
foundry (forge, cast, anvil)
sui CLI
rust + anchor CLI (Phase 6)
docker + docker compose
```

### First-time setup
```bash
cp .env.example .env   # fill in your keys
pnpm install
```

### Running locally
```bash
# Start infrastructure (Postgres)
docker compose -f infra/docker/docker-compose.dev.yml up -d

# Start relayer in dev mode
pnpm relayer:dev

# EVM tests
pnpm contracts:test:evm

# Sui tests
pnpm contracts:test:sui
```

---

## Important References

- LayerZero v2 OApp pattern: https://docs.layerzero.network/v2/developers/evm/oapp/overview
- Walrus SDK docs: https://docs.walrus.site/developer-guide/
- Sui Move stdlib: https://github.com/MystenLabs/sui/tree/main/crates/sui-framework
- Seal docs (Phase 9): https://docs.seal.sui.io/

---

## ADR Index

| # | Decision | Status |
|---|----------|--------|
| 001 | Monorepo with Turborepo | Accepted |
| 002 | LayerZero v2 for cross-chain messaging | Accepted |
| 003 | BlobGuard as Sui shared object | Accepted |
| 004 | Nonce registry on Sui (not origin chain) | Accepted |

Full ADRs in `docs/decisions/`

---

## Working With This Codebase

**Starting a new feature**: Check current phase above → check relevant package README → write tests first.

**When stuck on Move**: The BlobGuard shared object is the most complex piece. See `docs/decisions/003-blobguard-state-machine.md`.

**When stuck on LayerZero**: The OApp pattern requires implementing `_lzReceive` on both ends. See `packages/contracts-evm/src/BosphorAdapter.sol`.

**Updating this file**: After any significant architectural decision, update the relevant section here.
