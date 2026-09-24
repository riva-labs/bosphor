---
sidebar_position: 11.5
title: Multi-chain Testing
---

# Multi-chain Testing

Bosphor accepts storage intents from two origin chains, EVM (Sepolia) and Solana (devnet), and settles both through the same Sui/Walrus pipeline. This page lists how each chain is tested, the gas and compute costs measured from those tests, and the fee-abstraction results. Every number comes from the command shown with it.

## Test matrix

| Layer | EVM | Solana | Command |
|-------|-----|--------|---------|
| Contract unit tests | `contracts/evm` (Forge) | `contracts/solana` (Rust unit tests) | `forge test`, `cargo test -p bosphor-adapter` |
| Codec parity | Solidity `CommitmentCodec` tests | Rust `commitment-codec` vectors | `forge test`, `npm run test:codec` |
| SDK client | `sdk/src/evm` | `sdk/src/solana` (fake chain backend) | `cd sdk && npm test` |
| Solana script helpers | n/a | escrow codec, 429 backoff | `cd scripts/solana && npm test` |
| Fee abstraction | ETH origin | SOL origin | `cd relayer && npx jest src/pricing/fee-abstraction.spec.ts` |
| Priced round-trip (live) | `npm run test:e2e:priced` | `npm run test:e2e:priced:solana` | see [End-to-end scripts](#end-to-end-scripts) |

Results recorded on 2026-09-24 from the commands below:

| Command | Result |
|---------|--------|
| `cd contracts/evm && forge test --gas-report` (Forge 1.6.0-v1.7.0) | 62 tests passed, 0 failed |
| `cd contracts/solana && cargo test -p bosphor-adapter` | 9 tests passed (escrow state machine, message layout, intent-id parity) |
| `cd sdk && npm test` | 51 tests passed |
| `cd scripts/solana && npm test` | 7 tests passed |
| `cd relayer && npx jest src/pricing/fee-abstraction.spec.ts --verbose` | 7 tests passed |

## EVM gas (Forge gas report)

```bash
cd contracts/evm
forge test --gas-report
```

The Forge tests run against a minimal `EndpointV2Mock`, not the real LayerZero endpoint. `submitIntent` below therefore excludes the real endpoint, send library, and DVN/executor fee accounting, and the on-chain cost on Sepolia is higher. Treat these as the adapter's own gas.

### `BosphorEscrowAdapter` (M4 priced path)

Deployment: 4,237,229 gas (20,043 bytes).

| Function | Min | Avg | Median | Max | Calls |
|----------|----:|----:|-------:|----:|------:|
| `submitIntent` (opens the escrow) | 128,687 | 254,914 | 263,502 | 263,502 | 22 |
| `refund` | 24,448 | 47,334 | 58,665 | 58,806 | 6 |
| `withdraw` | 28,568 | 31,354 | 32,747 | 32,747 | 3 |
| `withdrawToken` | 57,376 | 57,376 | 57,376 | 57,376 | 1 |
| `depositUsdcWithPermit2` | 25,850 | 218,214 | 314,397 | 314,397 | 3 |
| `confirmExecution` | 25,219 | 38,752 | 38,752 | 52,286 | 2 |
| `getEscrow` (view) | 10,523 | 10,523 | 10,523 | 10,523 | 8 |

Forge counts reverted calls from negative tests too (for example a refund attempted before the deadline), which pulls the minimum down, so the median is the better guide to a successful call.

### `BosphorAdapter` (unpriced path)

Deployment: 2,684,042 gas (12,935 bytes).

| Function | Min | Avg | Median | Max | Calls |
|----------|----:|----:|-------:|----:|------:|
| `submitIntent` | 23,981 | 162,988 | 184,123 | 184,123 | 19 |
| `confirmExecution` | 25,299 | 37,792 | 29,720 | 52,366 | 7 |
| `quote` (view) | 15,186 | 15,186 | 15,186 | 15,186 | 1 |

### Proof delivery (release)

The return proof reaches the adapter through the endpoint's `lzReceive`, which is where the escrow release happens. In the tests the mock endpoint drives it through `simulateLzReceive`, so this row includes the mock's own overhead and covers both adapters:

| Function | Min | Avg | Median | Max | Calls |
|----------|----:|----:|-------:|----:|------:|
| `EndpointV2Mock.simulateLzReceive` | 42,958 | 74,351 | 70,660 | 107,174 | 18 |

## Solana compute units

There is no LiteSVM or local-validator test setup for the Solana program yet, so compute units are measured by simulation against devnet with `scripts/solana/src/measure-cu.ts`. The script is read-only: it uses `simulateTransaction` with signature verification off, so it needs only a funded public key and never sends a transaction. It refuses to run against any cluster whose genesis hash is not devnet's.

```bash
cd scripts/solana
npm install
BOSPHOR_ENV_FILE=../../.env.testnet-e2e npm run measure-cu

# Also measure refund_escrow on an expired, still-pending escrow
REFUND_INTENT_ID=0x<intent id> npm run measure-cu

# Read compute units from already-confirmed transactions (e.g. lz_receive releases)
CU_SIGNATURES=<sig1>,<sig2> npm run measure-cu
```

It prints a table of `submit_intent` (priced, including the LayerZero `send` CPI), optionally `refund_escrow`, and any confirmed transactions you name. The simulation sets the 1.4M per-transaction ceiling so it reports true usage rather than a cap. `submit_intent` is sent with a 400,000 CU limit in practice because the endpoint CPI exceeds the 200k default.

Results: not yet recorded. Run the command above on devnet and add the table here.

## Fee abstraction

The user pays one origin-native amount (ETH or SOL) that must cover the whole downstream cost stack: WAL storage, Sui gas, and the LayerZero return leg. The suite checks this across blob sizes (1 KiB, 1 MiB, 5 MiB, 10 MiB) on both origins.

```bash
cd relayer
npx jest src/pricing/fee-abstraction.spec.ts --verbose
```

| Test | Result |
|------|--------|
| ETH origin: the single escrow amount covers the full downstream cost stack | passed |
| ETH origin: the user pays ONE origin-native amount = escrow + forward fee | passed |
| ETH origin: cost per blob size is monotonic non-decreasing | passed |
| SOL origin: the single escrow amount covers the full downstream cost stack | passed |
| SOL origin: the user pays ONE origin-native amount = escrow + forward fee | passed |
| SOL origin: cost per blob size is monotonic non-decreasing | passed |
| WAL cost is a small fraction of the round-trip (return leg dominates) | passed |

### Cost per blob size

`relayer/scripts/cost-curve.ts` prints the all-in escrow for a range of sizes using the real quote engine and WAL cost calculator. It runs offline with **simulated inputs**, not live prices: WAL $0.03, SUI $0.80, ETH $2,500, SOL $100 (override with `WAL_USD`, `SUI_USD`, `ETH_USD`, `SOL_USD`), a return-leg fee of 1.76 SUI, Sui gas of 0.01 SUI, 5 epochs, and a representative Walrus system state (1,000 shards). The live relayer quotes from live prices instead (see [Payment flow](payment-flow.md)).

```bash
cd relayer
npx tsx scripts/cost-curve.ts
```

| Blob size | WAL units | WAL cost | Escrow (USD) | Escrow, ETH origin (wei) | Escrow, SOL origin (lamports) |
|-----------|----------:|---------:|-------------:|-------------------------:|------------------------------:|
| 1 KiB | 63 | $0.00098 | $2.0530 | 821211000000000 | 20530273 |
| 64 KiB | 63 | $0.00098 | $2.0530 | 821211000000000 | 20530273 |
| 1 MiB | 67 | $0.00105 | $2.0531 | 821243000000000 | 20531062 |
| 5 MiB | 84 | $0.00131 | $2.0534 | 821377000000000 | 20534417 |
| 10 MiB | 107 | $0.00167 | $2.0539 | 821559000000000 | 20538956 |

Under these inputs the escrow is almost flat across sizes: WAL storage is a fraction of a cent, and the SUI-denominated return leg dominates the price.

## End-to-end scripts

The end-to-end scripts run against live testnet infrastructure and are not part of CI. Point them at a testnet env file with `BOSPHOR_ENV_FILE`; never at a mainnet `.env`.

| Script | Chain | What it proves |
|--------|-------|----------------|
| `npm run test:e2e` | EVM | Unpriced round-trip: submit, LayerZero delivery to Sui, Walrus store, proof back to EVM |
| `npm run test:e2e:priced` | EVM | Priced release (escrow Pending to Released, relayer credited) and deadline refund (payer credited the full escrow) |
| `npm run test:e2e:priced:solana` | Solana devnet | Priced release (escrow vault closed by the proof, beneficiary credited the whole vault) and deadline refund (`refund_escrow` returns the vault to the payer) |

```bash
# EVM priced round-trip
BOSPHOR_ENV_FILE=.env.testnet-e2e npm run test:e2e:priced

# Solana priced round-trip (Solana deps live in scripts/solana)
(cd scripts/solana && npm install)
BOSPHOR_ENV_FILE=.env.testnet-e2e npm run test:e2e:priced:solana
```

The Solana script's phases, requirements, and rate-limit handling are described in the [Testing Guide](testing.md#solana-priced-end-to-end-test).

Results: live pass logs are not yet recorded on this page. Run both priced scripts and attach their output (intent ids, escrow and release/refund transactions) here.

## Related

- [Relayer benchmarks](benchmarks.md) for relayer latency, throughput, and fault tolerance
- [Testing Guide](testing.md) for how to run each suite
- [Payment flow](payment-flow.md) for the escrow design both chains share
