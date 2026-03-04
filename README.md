# Bosphor

**Storage Intent Router for Walrus** — enabling any chain to use Walrus decentralized storage as a native feature.

> Making permanence portable.

## Overview

Bosphor bridges EVM chains and Solana to Sui's Walrus storage layer. Developers submit signed `StorageIntents` on their home chain; Bosphor handles routing, execution, lifecycle management, and proof delivery.

```
[EVM / Solana] → Intent → [Relayer] → [Sui + Walrus] → Proof → [Origin Chain]
```

## Packages

| Package | Description |
|---------|-------------|
| `packages/contracts-evm` | Solidity contracts (BosphorAdapter, LayerZero OApp) |
| `packages/contracts-sui` | Move modules (WalrusExecutor, BlobGuard) |
| `packages/contracts-solana` | Rust/Anchor programs (Phase 6) |
| `packages/relayer` | Node.js event-driven relay service |
| `packages/sdk` | Unified TypeScript SDK |
| `packages/dashboard` | Internal dev portal (Next.js) |

## Getting Started

### Prerequisites

- Node.js 20+, pnpm 9+
- [Foundry](https://getfoundry.sh)
- [Sui CLI](https://docs.sui.io/guides/developer/getting-started/sui-install)
- Docker + Docker Compose

### Setup

```bash
git clone https://github.com/YOUR_ORG/bosphor.git
cd bosphor
cp .env.example .env    # fill in your keys
pnpm install
```

### Run locally

```bash
# Start Postgres
docker compose -f infra/docker/docker-compose.dev.yml up -d

# Start relayer in dev mode
pnpm relayer:dev
```

### Run tests

```bash
pnpm test                        # all TypeScript tests
pnpm contracts:test:evm          # forge test
pnpm contracts:test:sui          # sui move test
```

## Architecture

See [CLAUDE.md](./CLAUDE.md) for full architecture documentation.

Architecture decisions are documented in [docs/decisions/](./docs/decisions/).

## Project Phases

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Cross-Chain Execution Core (EVM + Sui + LayerZero) | 🟡 In Progress |
| 2 | Proof Settlement Layer | ⬜ |
| 3 | BlobGuard & Lifecycle Layer | ⬜ |
| 4 | Security & System Validation | ⬜ |
| 5 | Stabilization & Production Hardening | ⬜ |
| 6 | Solana Adapter | ⬜ |
| 7 | Unified SDK v2 | ⬜ |
| 8 | GTM — Ecosystem Rollout | ⬜ |
| 9 | Seal Privacy Integration | ⬜ |

## License

MIT
