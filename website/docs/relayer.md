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

### Network presets

`NETWORK` selects a preset: `testnet` (the default) or `mainnet`.

- `testnet` keeps the historical defaults listed below (Sepolia, Solana devnet, Sui testnet), so an existing testnet relayer that never sets `NETWORK` behaves exactly as before.
- `mainnet` has no testnet fallbacks. The relayer refuses to start unless the chain-specific values below are set, and it rejects obvious testnet leftovers (a `40xxx` endpoint id, a testnet chain id such as Sepolia, or an RPC URL containing `testnet`, `devnet` or `sepolia`).

| Variable | `testnet` default | `mainnet` default |
|----------|-------------------|-------------------|
| `EVM_DST_EID` | `40161` (Sepolia) | required, for example `30101` (Ethereum), `30184` (Base), `30110` (Arbitrum) |
| `EVM_CHAIN_ID` | `11155111` (Sepolia) | required, must match `EVM_DST_EID` for the known chains |
| `SUI_NETWORK` | `testnet` | `mainnet` (must not be `testnet`) |
| `SUI_GRPC_URL` | `https://sui-testnet.mystenlabs.com` | required |
| `SOLANA_SRC_EID` | `40168` (Solana devnet) | `30168` (Solana mainnet) |
| `QUOTE_RETURN_LZ_FEE_MIST` | `1760000000` (testnet-calibrated) | required, measure the live Sui to origin LayerZero fee |
| `BREAK_EVEN_GUARD_ENABLED` | `false` | `true` |

On mainnet the WAL auto top-up does not swap (the SUI to WAL exchange only exists on Walrus testnet). A low WAL balance raises the top-up failure metric and must be funded manually.

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
| `NETWORK` | `testnet` | Network preset, `testnet` or `mainnet` (see [Network presets](#network-presets)) |
| `EVM_DST_EID` | preset | EVM destination endpoint ID for proof verification |
| `EVM_CHAIN_ID` | preset | Chain id of the network behind `EVM_RPC_URL`. Pins the provider to a static network so startup never depends on runtime chain-id discovery over a flaky RPC |
| `SUI_GRPC_URL` | preset | Sui gRPC endpoint |
| `SUI_LZ_PACKAGE_ID` | - | LZ receiver package ID (required for proof verification) |
| `SUI_LZ_CONFIG_ID` | - | LzReceiverConfig shared object ID |
| `SUI_LZ_OAPP_ID` | - | OApp shared object ID |
| `SUI_LZ_MESSAGING_CHANNEL` | - | LZ messaging channel object ID |
| `SOLANA_RPC_URL` | - | Solana RPC endpoint. Set with `SOLANA_PROGRAM_ID` to accept Solana-origin intents; unset keeps the relayer EVM-only |
| `SOLANA_PROGRAM_ID` | - | Bosphor Solana adapter program id, watched for `IntentSubmitted` so ingest and `execute_store` work for Solana origins |
| `SOLANA_SUI_RECIPIENT` | relayer's Sui address | Sui address that receives the stored blob for a Solana-origin intent (a Solana pubkey cannot own a Sui object) |
| `SOLANA_SRC_EID` | preset | Origin endpoint id that marks a Solana-origin intent, so its return proof is confirmed on Solana rather than EVM |
| `SOLANA_RELAYER_KEYPAIR` | - | Store-admin keypair (inline JSON secret-key array or a path) that signs the Solana return leg `confirm_execution`. Unset disables the return leg |
| `WALRUS_STORE_EPOCHS` | `5` | Legacy fallback only. Blobs are stored for the intent's committed `storageEpochs`; this default applies only to a commitment recorded without epochs, and the relayer logs each such fallback |
| `WALRUS_MAX_EPOCHS` | `53` | Largest committed storage duration the relayer stores (Walrus's own max epochs ahead also applies). Larger commitments are dead-lettered before any WAL spend, never shortened, and the escrow refunds on the deadline |
| `WAL_MIN_BALANCE_MIST` | `500000000` | WAL floor (0.5 WAL); below this the relayer auto-swaps SUI for WAL |
| `WAL_TOPUP_SUI_MIST` | `1000000000` | SUI to swap per top-up (1 SUI) |
| `WAL_TOPUP_SUI_RESERVE_MIST` | `1000000000` | SUI kept in reserve for gas, never spent on a swap (1 SUI) |
| `INTENT_TTL_MS` | `3600000` | TTL for processed intent deduplication (ms) |
| `PORT` | `3000` | Public HTTP API port |
| `METRICS_PORT` | `9464` | Internal Prometheus port serving `GET /metrics`. Must differ from `PORT`; never route it through the public tunnel |
| `METRICS_HOST` | `0.0.0.0` | Bind address of the metrics port |
| `METRICS_TOKEN` | - | Optional bearer token required on scrapes (`Authorization: Bearer <token>`) |
| `CORS_ORIGINS` | `*` | Comma-separated origins allowed to call the API from a browser. `*` allows any origin. `DASHBOARD_ORIGIN` is always added to an explicit list |
| `RATE_LIMIT_ENABLED` | `true` | Rate limiting for `POST /quote`, `POST /blob/{intentId}`, `POST /blob/encode` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window length |
| `RATE_LIMIT_PER_IP` | `120` | Requests per window per client IP (all three routes together) |
| `RATE_LIMIT_ENCODE_PER_IP` | `30` | Extra per-IP budget for `POST /blob/encode` |
| `RATE_LIMIT_PER_APP` | `0` (off) | Requests per window per `X-Bosphor-App` id, across IPs. App ids are self-declared, so leave off until they are authenticated |
| `RATE_LIMIT_BYPASS_KEYS` | - | Comma-separated secrets. A request with one in the `X-Bosphor-Key` header skips the limits (for trusted server-side callers whose users share one egress IP) |
| `TRUST_PROXY` | `false` | Take the client IP from `CF-Connecting-IP` / `X-Forwarded-For`. Enable only when the relayer is reachable solely through Cloudflare / nginx; otherwise all clients share the proxy IP (off) or can spoof theirs (on while directly reachable) |
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
| `RETURN_MAX_ATTEMPTS` | `20` | Return-leg attempts (blob already stored) before the return is dead-lettered; the storage itself never is |
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
- **Retry and dead-letter.** A pre-store failure retries with exponential backoff up to `MAX_STORE_ATTEMPTS`, then dead-letters (`state = 'dead'`, bytes freed, `store_dead_letter_total{phase="pre_store"}`). A return-leg failure (blob already stored) never dead-letters the storage: it retries up to `RETURN_MAX_ATTEMPTS` and then dead-letters only the return (`phase="return"`). The cap stops endless retries from minting orphaned LayerZero nonces that would wedge the return channel; the blob stays stored and the origin escrow refunds the payer after its deadline.
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

The relayer exposes Prometheus metrics at `GET /metrics` on a separate internal port, `METRICS_PORT` (default 9464), in the standard text exposition format (`Content-Type: text/plain; version=0.0.4`). The public API port (`PORT`) does not serve `/metrics`: the exposition includes wallet balances and queue internals. Keep the metrics port on the internal network (do not route it through the Cloudflare tunnel or nginx), and optionally set `METRICS_TOKEN` to require a bearer token. The provided `monitoring/prometheus.yml` scrapes `relayer:9464` over the compose network, and the testnet relayer through the host at `host.docker.internal:9465` (publish its container port 9464 on host port 9465).

Alongside the default `prom-client` process metrics (`process_cpu_seconds_total`, memory, event loop lag, and so on), the relayer emits:

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `bosphor_relayer_intents_processed_total` | counter | `result` (`success`/`failure`), `path` (`evm`/`sui_lz`) | Intents processed, split by detection path and outcome |
| `bosphor_relayer_lz_send_total` | counter | `result` (`success`/`failure`) | LayerZero proof sends back to EVM |
| `bosphor_relayer_checkpoint_cursor_lag` | gauge | (none) | Latest Sui checkpoint minus the processed cursor |
| `bosphor_relayer_walrus_upload_seconds` | histogram | (none) | Walrus upload duration in seconds |
| `bosphor_relayer_compute_latency_seconds` | histogram | (none) | Relayer **compute** latency: store span minus external chain/Walrus/LZ I/O. This is the sub-3s KPI |
| `bosphor_relayer_processing_latency_seconds` | histogram | (none) | End-to-end store latency (observe to work-complete), I/O-bound. Honest gauge, **not** the KPI |
| `bosphor_relayer_wal_balance_wal` | gauge | (none) | Relayer WAL balance (the Walrus storage token) |
| `bosphor_relayer_sui_balance_sui` | gauge | (none) | Relayer SUI balance (gas + WAL swap funding) |
| `bosphor_relayer_wal_topup_total` | counter | `result` (`success`/`failure`/`insufficient_sui`) | SUI→WAL auto top-up attempts |
| `bosphor_relayer_staged_intent_active` | gauge | (none) | Durable-queue rows still active (crude queue length) |
| `bosphor_relayer_staged_bytes` | gauge | (none) | Total committed bytes still held in the queue (backpressure headroom vs `MAX_STAGED_BYTES`) |
| `bosphor_relayer_staged_dead` | gauge | (none) | Durable-queue rows that dead-lettered |
| `bosphor_relayer_store_dead_letter_total` | counter | `phase` (`pre_store`/`return`) | Dead-lettered stores (`pre_store`) and undelivered return proofs (`return`) |
| `bosphor_relayer_ledger_ops_total` | counter | `src_eid`, `app_id` (`none`, the app id, or `other` past 100 distinct ids) | Completed storage ops newly recorded in the durable ops ledger |
| `bosphor_relayer_ledger_bytes_total` | counter | `src_eid` | Bytes stored across ops recorded in the ledger |
| `bosphor_relayer_ledger_write_failures_total` | counter | (none) | Inline ledger writes that failed (the backfill sweep retries them) |
| `bosphor_relayer_rate_limited_total` | counter | `scope` (`ip`/`app`/`encode`) | Integrator API requests rejected with 429 |

The `path` label distinguishes the two ways an intent is detected: `evm` (polled directly from the EVM adapter) and `sui_lz` (received on Sui via LayerZero). A rising `checkpoint_cursor_lag` indicates the relayer is falling behind the Sui chain tip.

### Latency metrics and the sub-3s KPI

There are two latency figures, and they measure deliberately different things:

- **`bosphor_relayer_compute_latency_seconds` (the sub-3s KPI).** The relayer's own reaction time: the store span **minus** the wall time spent waiting on external I/O it does not control (the Walrus upload relay, Sui `execute_store` + finality wait, the LayerZero fee quote and send-proof, WAL top-ups, escrow reads, live price fetches). This isolates how fast the relayer acts once it can act, and is what the M4 "median relay latency < 3s" deliverable is measured against.
- **`bosphor_relayer_processing_latency_seconds` (end-to-end gauge, not the KPI).** The full observe to work-complete span, I/O included. On public testnet each external round-trip is seconds, so this typically sits in the **10-30s** range. It is reported openly for operational visibility; it is not the KPI and should never be quoted as one.

The two differ only by external I/O time, tracked per intent by the relayer's I/O clock. Because any external call left untracked counts toward compute, the KPI figure is conservative by construction: it can only over-report, never flatter.

**Measuring the KPI.** Do not use the synthetic benchmark as evidence, it fabricates samples and only exercises the harness as a CI floor. Take the real number from a live relayer:

```bash
# From a live relayer's Prometheus endpoint (the honest KPI measurement).
# Use the relayer's METRICS_PORT (the testnet relayer publishes it on :9465):
BENCH_METRICS_URL=http://localhost:9465/metrics npm --prefix relayer run bench

# Or directly from the histogram:
curl -s http://localhost:9465/metrics | grep bosphor_relayer_compute_latency_seconds
```

To measure compute latency and throughput under concurrent load, use the load generator (`npm --prefix relayer run loadgen`); methodology and results are on [Relayer benchmarks](benchmarks.md).

The Grafana relayer dashboard's "Relayer compute latency p50 / p95" panel plots the KPI (green below the 3s threshold line) with the end-to-end p50 dashed alongside for context.

## Ops ledger and KPI export

Every completed store is written once to a durable Postgres table, `storage_op_ledger`, right after `execute_store` succeeds on Sui. Unlike the store queue (purged after `STAGED_RETENTION_MS`) and the Prometheus counters (reset on restart), ledger rows are never deleted, so usage figures can be recomputed for any window.

Each row holds: `intent_id`, `src_eid` (origin chain), `sender`, `size`, `blob_id` (the committed id), `walrus_blob_id`, `walrus_object_id`, `end_epoch`, `app_id` (from the `X-Bosphor-App` header, null when none was sent), `network`, `store_digest`, `created_at` (intent first seen) and `stored_at`.

The write is exactly-once per intent (an idempotent insert keyed on `intent_id`) and never fails the store. If it fails, the error is logged and counted in `bosphor_relayer_ledger_write_failures_total`, and a backfill sweep (every 30 seconds) records the op later. A completed store is kept in the queue table until it has been recorded, so no op is lost to the reaper.

### KPI export script

`relayer/scripts/kpi.ts` prints a KPI package for a time window as JSON and markdown: total ops, ops and bytes by origin chain, total bytes, unique senders, unique app ids, ops per app, compute latency p50 / p95, and `@bosphor/sdk` npm downloads.

```bash
DATABASE_URL=postgres://bosphor:...@localhost:5432/bosphor_testnet \
PROMETHEUS_URL=http://localhost:9091 \
PROMETHEUS_SELECTOR='deployment="testnet"' \
  npm --prefix relayer run kpi -- --since 2026-09-01 --until 2026-10-01 --network testnet
```

| Argument / variable | Meaning |
|---------------------|---------|
| `--since` (required) | Window start, ISO date or epoch ms (inclusive) |
| `--until` | Window end (exclusive), default now |
| `--network` | Only count ledger rows of this network label (`testnet` / `mainnet`) |
| `--format` | `both` (default), `json` or `md` |
| `DATABASE_URL` | Postgres holding `storage_op_ledger` |
| `PROMETHEUS_URL` | Prometheus base URL for the latency quantiles (`histogram_quantile` over `bosphor_relayer_compute_latency_seconds_bucket` across the window) |
| `PROMETHEUS_SELECTOR` | Optional label matcher to pick one relayer |

The script never estimates a number. A source it cannot read (no `DATABASE_URL`, Prometheus down or without samples in the window, npm API error) is printed as `unavailable` with the reason. It does not load a `.env` file by itself, so point it explicitly at the database you mean to report on.

The Grafana relayer dashboard shows the same ledger data live: ops by origin chain, cumulative bytes stored and unique apps.

## Walrus upload

The relayer uploads intent payloads to Walrus using the `@mysten/walrus` SDK's `writeBlob()` method. The SDK manages sliver distribution, certification, retries, and epoch management natively.

- All blobs are stored as **deletable**
- Blob ownership is transferred to the relayer's Sui address
- Storage duration is the intent's committed `storageEpochs`, so the stored end epoch covers what the Sui executor checks (`current_epoch + storageEpochs`). The break-even guard and WAL cost metering use the same duration. `WALRUS_STORE_EPOCHS` (default 5) is used only when a commitment carries no epochs
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
