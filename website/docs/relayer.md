---
sidebar_position: 6
title: Relayer Operator Guide
---

# Relayer Operator Guide

The Bosphor relayer is a NestJS service that bridges Sui and EVM. It watches both chains for events (EVM via polling, Sui via gRPC checkpoint streaming), uploads payloads to Walrus, executes storage intents on Sui, and sends execution proofs back to EVM via LayerZero.

import AgentPrompt from '@site/src/components/AgentPrompt';

<AgentPrompt prompt="Set up and run the Bosphor relayer service. Copy `relayer/.env.example` to `relayer/.env` and help me fill in the required variables: EVM_RPC_URL, EVM_RELAYER_KEY, EVM_ADAPTER_ADDRESS, SUI_RELAYER_KEY, SUI_PACKAGE_ID, SUI_CONFIG_ID, and WALRUS_RELAY_URL. The LZ infrastructure variables are pre-filled in the example. Then run `cd relayer && npm install && npm run start:dev` and verify the health endpoint responds at GET /health." />

## How it works

1. Receives `IntentReceived` events from Sui via gRPC checkpoint streaming (delivered by LayerZero from EVM)
2. Uploads the intent payload to Walrus as a deletable blob
3. Calls `execute_store` on Sui with the certified blob
4. Quotes the LZ fee for proof verification (adds 10% buffer)
5. Calls `lz_send_proof` on Sui to send the proof back to EVM
6. EVM `_lzReceive` marks the intent as executed

The relayer does not have custody of user funds. It triggers execution and proof delivery, but all proof messages are DVN-verified by LayerZero.

## Configuration

### Required environment variables

| Variable | Description |
|----------|-------------|
| `EVM_RPC_URL` | Sepolia RPC endpoint |
| `EVM_RELAYER_KEY` | Private key (0x-prefixed) with Sepolia ETH for gas |
| `EVM_ADAPTER_ADDRESS` | Deployed BosphorAdapter contract address |
| `SUI_RELAYER_KEY` | Sui private key (`suiprivkey1...` or base64 Ed25519) |
| `SUI_PACKAGE_ID` | walrus_executor package ID |
| `SUI_CONFIG_ID` | ExecutorConfig shared object ID |
| `WALRUS_RELAY_URL` | Walrus upload relay endpoint |

### Optional environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EVM_DST_EID` | `40161` | EVM destination endpoint ID for proof verification |
| `SUI_GRPC_URL` | `https://sui-testnet.mystenlabs.com` | Sui gRPC endpoint |
| `SUI_LZ_PACKAGE_ID` | - | LZ receiver package ID (required for proof verification) |
| `SUI_LZ_CONFIG_ID` | - | LzReceiverConfig shared object ID |
| `SUI_LZ_OAPP_ID` | - | OApp shared object ID |
| `SUI_LZ_MESSAGING_CHANNEL` | - | LZ messaging channel object ID |
| `SOLANA_RPC_URL` | - | Solana RPC endpoint. Set with `SOLANA_PROGRAM_ID` to accept Solana-origin intents; unset keeps the relayer EVM-only |
| `SOLANA_PROGRAM_ID` | - | Bosphor Solana adapter program id, watched for `IntentSubmitted` so ingest and `execute_store` work for Solana origins |
| `SOLANA_SUI_RECIPIENT` | relayer's Sui address | Sui address that receives the stored blob for a Solana-origin intent (a Solana pubkey cannot own a Sui object) |
| `SOLANA_SRC_EID` | `40168` | Origin endpoint id that marks a Solana-origin intent, so its return proof is confirmed on Solana rather than EVM |
| `SOLANA_RELAYER_KEYPAIR` | - | Store-admin keypair (inline JSON secret-key array or a path) that signs the Solana return leg `confirm_execution`. Unset disables the return leg |
| `WALRUS_STORE_EPOCHS` | `5` | Number of Walrus storage epochs |
| `WAL_MIN_BALANCE_MIST` | `500000000` | WAL floor (0.5 WAL); below this the relayer auto-swaps SUI for WAL |
| `WAL_TOPUP_SUI_MIST` | `1000000000` | SUI to swap per top-up (1 SUI) |
| `WAL_TOPUP_SUI_RESERVE_MIST` | `1000000000` | SUI kept in reserve for gas, never spent on a swap (1 SUI) |
| `INTENT_TTL_MS` | `3600000` | TTL for processed intent deduplication (ms) |
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |

### Durable store queue variables

The store path is a durable Postgres queue (see [Durable store queue](#durable-store-queue) below). It is active only when `DATABASE_URL` is set; without it the relayer validates ingest but has nowhere durable to persist and does not process stores.

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | - | Postgres connection string. Enables the durable store queue (and the public intent feed). Unset means in-memory dev only, no store processing |
| `MAX_INGEST_BLOB_BYTES` | `10485760` | Absolute per-blob cap (10 MiB); an oversized upload is rejected before allocation |
| `MAX_STAGED_BYTES` | `268435456` | Aggregate backpressure ceiling (256 MiB). Over this, ingest sheds load with `503` + `Retry-After` |
| `STORE_CONCURRENCY` | `4` | Intents stored in parallel per claim tick |
| `STORE_BATCH_SIZE` | `20` | Rows scanned per claim tick (upper bound on per-tick work) |
| `STORE_BACKOFF_BASE_MS` | `2000` | Exponential backoff base for a failed store: `min(BASE * 2^attempts, CAP)` |
| `STORE_BACKOFF_CAP_MS` | `300000` | Backoff ceiling (5 min) |
| `MAX_STORE_ATTEMPTS` | `8` | Pre-store attempts (blob not yet on Walrus+Sui) before dead-lettering |
| `RETURN_MAX_ATTEMPTS` | `20` | Return-leg attempts (blob already stored) before alerting; never dead-letters |
| `STORE_ATTEMPT_TIMEOUT_MS` | `120000` | Upper bound on one store attempt (2 min); a hung call is aborted and rescheduled |
| `STAGED_RETENTION_MS` | `86400000` | Retention for terminal rows (24 h); the reaper purges older rows |
| `SHUTDOWN_DRAIN_MS` | `30000` | Graceful-shutdown drain budget; in-flight stores get this long to settle before exit |

### LZ infrastructure variables

The relayer needs references to 18 LayerZero v2 shared objects on Sui testnet. These are pre-filled in `relayer/.env.example` and rarely change:

- `SUI_LZ_ENDPOINT_V2`, `SUI_LZ_ENDPOINT_V2_OBJ`
- `SUI_LZ_ULN302`, `SUI_LZ_ULN302_OBJ`
- `SUI_LZ_EXECUTOR_PKG`, `SUI_LZ_EXECUTOR_OBJ`
- `SUI_LZ_EXEC_FEE_LIB`, `SUI_LZ_EXEC_FEE_LIB_OBJ`
- `SUI_LZ_DVN_PKG`, `SUI_LZ_DVN_OBJ`
- `SUI_LZ_DVN_FEE_LIB`, `SUI_LZ_DVN_FEE_LIB_OBJ`
- `SUI_LZ_PRICE_FEED`, `SUI_LZ_PRICE_FEED_OBJ`
- `SUI_LZ_TREASURY`, `SUI_LZ_TREASURY_OBJ`

Copy `relayer/.env.example` for testnet defaults.

## Running

### Local development

```bash
cd relayer
npm install
cp .env.example .env
# Fill in required variables
npm run start:dev
```

### Docker

```bash
docker-compose up -d
```

The Docker container runs the relayer with the environment from `.env`.

## Event detection and deduplication

The relayer uses two different mechanisms for event detection:

- **EVM**: Polls every 5 seconds via `@Interval`
- **Sui**: Receives events in near-real-time via gRPC checkpoint streaming with automatic backfill on startup and exponential backoff reconnection
- **Solana** (optional): When `SOLANA_RPC_URL` and `SOLANA_PROGRAM_ID` are set, polls the adapter program's `IntentSubmitted` events every 5 seconds and records the commitment, so a Solana-origin intent's out-of-band bytes bind and `execute_store` runs exactly like an EVM origin. Origin detection is uniform: fulfillment is always driven by the Sui `IntentReceived` delivery, regardless of source chain. The return proof is routed back to the origin chain: a Solana-origin intent is confirmed on Solana via the adapter's `confirm_execution` (signed with `SOLANA_RELAYER_KEYPAIR`), the mirror of the EVM `confirmExecution` fallback.

Detection and storage are decoupled through the durable store queue: the checkpoint callback only records that `IntentReceived` fired, and a separate single-writer loop does the storage. Deduplication is durable, not in-memory: every row is terminal-sticky (`state = 'active'` guards every write), so a backfilled event can never resurrect a `done`/`dead`/`expired` intent. On-chain guards (`EIntentAlreadyExecuted`, `AlreadyExecuted`) remain the last line of defense against double-execution.

## Durable store queue

Once the bytes for an intent are accepted at ingest, the whole store path is a durable Postgres queue (`staged_intent`), so a crash never loses accepted bytes or repeats paid work. It is active only when `DATABASE_URL` is set.

- **The table is the queue.** Ingest writes accepted bytes (BYTEA) plus the recomputed blob id and committed size into one row per intent; the Sui `IntentReceived` event flags the same row. There is no in-memory buffer.
- **One writer drains it.** A single loop every 2s (`CLAIM_INTERVAL_MS`) selects the oldest active, due rows and stores up to `STORE_CONCURRENCY` of them in parallel. Readiness (has bytes, received, committed sender known, deadline in the future) is recomputed each tick, not stored.
- **Per-step idempotency.** Each step persists its result (`walrus_object_id`, `store_digest`) before the next, so a crash or retry re-runs only the unfinished steps. A retry never re-uploads (no double WAL spend) or re-records. Bytes are freed once the blob is safe on Walrus and recorded on Sui.
- **Backpressure.** Ingest sums the committed `size` of rows still holding bytes; over `MAX_STAGED_BYTES` it returns `503` + `Retry-After` instead of buffering unbounded. This is the OOM guard.
- **Retry and dead-letter.** A pre-store failure retries with exponential backoff up to `MAX_STORE_ATTEMPTS`, then dead-letters (`state = 'dead'`, bytes freed, `store_dead_letter_total{phase="pre_store"}`). A return-leg failure (blob already stored) never dead-letters the storage: it retries up to `RETURN_MAX_ATTEMPTS` and then alerts (`phase="return"`), because the WAL is already spent and the proof must eventually land.
- **Reaper.** A maintenance loop every 10s expires active rows whose deadline passed before they stored and purges terminal rows older than `STAGED_RETENTION_MS`.
- **Graceful shutdown.** On `SIGTERM` the processor stops claiming and waits up to `SHUTDOWN_DRAIN_MS` for in-flight stores to settle; anything still active resumes idempotently on the next boot.

### Migration: cutting over to the durable queue

An earlier relayer held accepted-but-unstored bytes in memory. Those bytes are not in Postgres and their `IntentReceived` events have already passed the checkpoint cursor, so they will not re-emit. Deploying the durable queue on top of a running old process would silently orphan them. Cut over with a drain-then-cut runbook, never a hot swap:

1. **Stop new ingest.** At the reverse proxy (nginx), return `503` for the ingest route so no new bytes are accepted.
2. **Drain the old process.** Wait until it has stored everything in flight (its buffered/pending logs go quiet and no stores are running). Its accepted bytes are now safely on Walrus + Sui.
3. **Deploy the new code.** With `DATABASE_URL` set, the new process boots against an empty `staged_intent` table, which is now correct (nothing is in flight to migrate).
4. **Re-open ingest.** Remove the `503` at the proxy. New uploads land directly in the durable queue.

No dual-run and no bridge code are needed. The relayer is not auto-deployed on merge (it runs under Docker on the host); deploy this change by hand following the steps above.

## Fee quoting

Before sending a proof back to EVM, the relayer quotes the LZ fee using `simulateTransaction` via gRPC on Sui. The quoted fee gets a 10% buffer to account for gas price fluctuations.

If the fee quote fails (e.g. LZ config variables not set), the relayer falls back to a default fee of 0.5 SUI (500,000,000 MIST).

The relayer wallet on Sui must have enough SUI balance to cover these fees.

## Health endpoint

The relayer exposes a health check at `GET /health` on the configured `PORT` (default 3000).

Response format:

```json
{
  "status": "ok",
  "evm": {
    "connected": true,
    "blockNumber": 12345678
  },
  "sui": {
    "connected": true,
    "checkpoint": "54321"
  },
  "uptime": 3600
}
```

| Field | Description |
|-------|-------------|
| `status` | `"ok"` if both chains connected, `"degraded"` otherwise |
| `evm.connected` | Whether the EVM RPC responds |
| `evm.blockNumber` | Latest EVM block number |
| `sui.connected` | Whether the Sui RPC responds |
| `sui.checkpoint` | Latest Sui checkpoint |
| `uptime` | Seconds since the relayer started |

## Metrics endpoint

The relayer exposes Prometheus metrics at `GET /metrics` on the configured `PORT` (default 3000), served in the standard text exposition format (`Content-Type: text/plain; version=0.0.4`). Point a Prometheus scrape job at this path. The provided `monitoring/prometheus.yml` is already configured to scrape `relayer:3000/metrics`.

Alongside the default `prom-client` process metrics (`process_cpu_seconds_total`, memory, event loop lag, and so on), the relayer emits:

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `bosphor_relayer_intents_processed_total` | counter | `result` (`success`/`failure`), `path` (`evm`/`sui_lz`) | Intents processed, split by detection path and outcome |
| `bosphor_relayer_lz_send_total` | counter | `result` (`success`/`failure`) | LayerZero proof sends back to EVM |
| `bosphor_relayer_checkpoint_cursor_lag` | gauge | (none) | Latest Sui checkpoint minus the processed cursor |
| `bosphor_relayer_walrus_upload_seconds` | histogram | (none) | Walrus upload duration in seconds |
| `bosphor_relayer_wal_balance_wal` | gauge | (none) | Relayer WAL balance (the Walrus storage token) |
| `bosphor_relayer_sui_balance_sui` | gauge | (none) | Relayer SUI balance (gas + WAL swap funding) |
| `bosphor_relayer_wal_topup_total` | counter | `result` (`success`/`failure`/`insufficient_sui`) | SUI→WAL auto top-up attempts |
| `bosphor_relayer_staged_intent_active` | gauge | (none) | Durable-queue rows still active (crude queue length) |
| `bosphor_relayer_staged_bytes` | gauge | (none) | Total committed bytes still held in the queue (backpressure headroom vs `MAX_STAGED_BYTES`) |
| `bosphor_relayer_staged_dead` | gauge | (none) | Durable-queue rows that dead-lettered |
| `bosphor_relayer_store_dead_letter_total` | counter | `phase` (`pre_store`/`return`) | Dead-lettered stores (`pre_store`) and undelivered return proofs (`return`) |

The `path` label distinguishes the two ways an intent is detected: `evm` (polled directly from the EVM adapter) and `sui_lz` (received on Sui via LayerZero). A rising `checkpoint_cursor_lag` indicates the relayer is falling behind the Sui chain tip.

## Walrus upload

The relayer uploads intent payloads to Walrus using the `@mysten/walrus` SDK's `writeBlob()` method. The SDK manages sliver distribution, certification, retries, and epoch management natively.

- All blobs are stored as **deletable**
- Blob ownership is transferred to the relayer's Sui address
- Storage duration is configured via `WALRUS_STORE_EPOCHS` (default: 5 epochs)
- The upload relay is configured via `WALRUS_RELAY_URL` in `SuiService`

### WAL auto top-up

Every Walrus store is paid for in WAL, which drains over time. There is no faucet in the fulfillment path, so the relayer refills itself: before each store (and on a background interval) it checks its WAL balance, and when WAL falls below `WAL_MIN_BALANCE_MIST` it swaps `WAL_TOPUP_SUI_MIST` of SUI for WAL on the Walrus testnet exchange (the same exchange `walrus get-wal` uses).

- The swap never spends the `WAL_TOPUP_SUI_RESERVE_MIST` SUI gas reserve. If SUI is too low to swap without eating the reserve, the top-up records `wal_topup_total{result="insufficient_sui"}` and logs an error instead, so the `BosphorRelayerWalTopUpBlocked` alert pages for a manual SUI refill.
- Concurrent intents trigger at most one swap; the check is serialized.
- As long as the relayer holds SUI, WAL is self-healing. Keep the relayer's Sui address funded with SUI.

## Error handling

| Scenario | Behavior |
|----------|----------|
| Intent deadline expired before store | Reaper marks the row `expired`, frees its bytes |
| Blob id / size mismatch at store | Terminal: row marked `dead`, bytes freed (no WAL spent) |
| Walrus upload failure | Row rescheduled with backoff; dead-lettered after `MAX_STORE_ATTEMPTS` |
| Sui `execute_store` failure | Same as upload: rescheduled with backoff, then dead-lettered |
| Return-leg (proof) failure | Storage stays safe; retried up to `RETURN_MAX_ATTEMPTS`, then alerts (never dead-letters) |
| Store attempt hangs | Aborted at `STORE_ATTEMPT_TIMEOUT_MS` and rescheduled |
| LZ fee quote failure | Return leg falls back to the owner-gated `confirmExecution` with identical proof bytes |

## Error tracking (Sentry)

The relayer reports runtime errors to Sentry when `SENTRY_DSN` is set (use the sentry.io free tier). Intent processing failures are captured with the `intentId` as context, so a failed round-trip is traceable to the exact intent. Set `SENTRY_ENVIRONMENT` to distinguish deployments (defaults to `production`). Leave `SENTRY_DSN` empty to disable reporting; the relayer runs unchanged without it. Never commit a real DSN.

## Related

- [Architecture](architecture.md) for the full message flow
- [Contract Interface](contract-interface.md) for Sui function signatures
- [Deployment](deployment.md) for initial setup
- [Testing](testing.md) for running relayer unit tests
