---
sidebar_position: 7
title: Testing Guide
---

# Testing Guide

Bosphor has four test layers: Solidity unit tests, Move unit tests, relayer unit tests, and an end-to-end cross-chain test. All four must pass before merging.

## Quick reference

```bash
# Run everything (except e2e, which needs live testnet)
(cd contracts && forge test -vvv)
(cd sui/lz-receiver && sui move test --build-env testnet)
(cd relayer && npm test)

# Full round-trip (requires deployed contracts + running relayer)
npm run test:e2e
```

## Solidity tests (Forge)

```bash
cd contracts
forge test -vvv
```

Tests are in `contracts/test/BosphorAdapter.t.sol`. They use a minimal `EndpointV2Mock` (not the full LZ TestHelper) to simulate LayerZero message delivery.

### What is covered

| Area | Tests |
|------|-------|
| `submitIntent` | Deadline validation, nonce increment, intent ID computation, duplicate rejection |
| `_lzReceive` | Type 1 message decoding (intentId, blobId, endEpoch), unknown type revert, empty message revert |
| `confirmExecution` | Owner-only access, replay prevention, deadline expiry check |
| `quote` | Fee estimation passthrough |
| `setRelayer` | Zero-address rejection, event emission |

### Key test details

- `EndpointV2Mock` simulates LZ `send` and `lzReceive` without DVN verification
- Type 1 wire format: 97 bytes (1 byte type + 32 intentId + 32 blobId + 32 endEpoch)
- DST_EID in tests: `30378`

## Move tests (Sui)

```bash
cd sui/lz-receiver
sui move test --build-env testnet
```

Tests are in `sui/lz-receiver/tests/lz_receiver_tests.move`.

### What is covered

| Area | Tests |
|------|-------|
| `lz_receive` | Intent recording, deduplication, message parsing |
| `build_proof_message` | Type-1 encoding, length validation, big-endian u256 encoding |
| `is_received` | View function correctness |

### Build environment

The `--build-env testnet` flag is required because the Move package depends on LayerZero v2 testnet packages published at specific addresses. Without this flag, the build fails on address resolution.

## Relayer unit tests (Jest)

```bash
cd relayer
npm test
```

Tests are in `relayer/src/**/*.spec.ts`. All external dependencies (Sui client, ethers provider, Walrus HTTP) are mocked.

### Test suites

| Suite | File | What is covered |
|-------|------|-----------------|
| IntentProcessor | `intent/intent.processor.spec.ts` | Full pipeline (upload, executeStore, lzSendProof), deduplication, TTL expiry, fee quote fallback, custom EVM_DST_EID |
| WalrusService | `walrus/walrus.service.spec.ts` | newlyCreated/alreadyCertified responses, 5xx retry with backoff, 4xx no-retry, timeout handling |
| EvmService | `chain/evm/evm.service.spec.ts` | Event polling, log parsing, confirmExecution retry (3 attempts, 2s delay) |
| SuiService | `chain/sui/sui.service.spec.ts` | lzSendProof PTB construction, quoteLzFee BCS parsing, error on missing LZ config |
| HealthService | `health/health.service.spec.ts` | ok/degraded status, uptime calculation |

### Key patterns

- **Deduplication TTL**: `IntentProcessor` tests verify that processed intents are re-processed after TTL expiration (`INTENT_TTL_MS`, default 1 hour)
- **Fee fallback**: When `quoteLzFee` fails, the relayer uses 500,000,000 MIST (0.5 SUI) as default
- **10% fee buffer**: The quoted fee is multiplied by 1.1 before passing to `lzSendProof`

## End-to-end test

```bash
npm run test:e2e
```

Requires deployed contracts on Sepolia + Sui testnet and a running relayer. The test verifies the full cross-chain round-trip in two phases.

### Phase 1: Forward (EVM to Sui)

1. Quotes the LZ fee on EVM
2. Calls `submitIntent` on BosphorAdapter
3. Polls the LayerZero Scan API until the message shows as DELIVERED on Sui

### Phase 2: Return (Sui to EVM)

4. Waits for the relayer to process the intent (Walrus upload + `execute_store` + `lz_send_proof`)
5. Polls EVM for `IntentExecuted` event
6. Decodes proof data (blob ID, end epoch) from the event

### Output

The test prints a 6-checkpoint summary with TX hashes and explorer links:

1. EVM intent submission TX
2. LZ Scan delivery status
3. Sui StorageExecuted event (optional, needs `SUI_PACKAGE_ID`)
4. Sui ProofSent event (optional, needs `SUI_LZ_PACKAGE_ID`)
5. EVM IntentExecuted event
6. Proof data verification (blob ID, end epoch decoded)

### Required environment variables

| Variable | Required |
|----------|----------|
| `EVM_RPC_URL` | Yes |
| `EVM_ADAPTER_ADDRESS` | Yes |
| `EVM_RELAYER_KEY` | Yes |
| `SUI_RPC_URL` | Optional (for Sui event details) |
| `SUI_PACKAGE_ID` | Optional (for StorageExecuted events) |
| `SUI_LZ_PACKAGE_ID` | Optional (for ProofSent events) |

### Timeouts

- Forward phase: 15 minutes
- Return phase: 15 minutes
- Poll interval: 15 seconds

## CI pipeline

The CI runs on every push to `main` and every pull request. See `.github/workflows/ci.yml`.

### Jobs

| Job | What it does |
|-----|-------------|
| `forge-tests` | Checks out with submodules, installs Foundry, runs `forge test -vvv` in `contracts/` |
| `move-tests` | Caches Sui CLI (v1.72.2), runs `sui move test --build-env testnet` in `sui/lz-receiver/` |
| `relayer-build-and-test` | Sets up Node.js 22, installs, builds, and tests the relayer |

All three jobs run in parallel. The E2E test is not included in CI because it requires live testnet deployments and a running relayer.

## Related

- [Contract Interface](contract-interface.md) for function signatures referenced in tests
- [Relayer](relayer.md) for the relayer configuration that tests mock
- [Deployment](deployment.md) for setting up the environment needed by E2E tests
