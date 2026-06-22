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
| `WALRUS_STORE_EPOCHS` | `5` | Number of Walrus storage epochs |
| `INTENT_TTL_MS` | `3600000` | TTL for processed intent deduplication (ms) |
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Log level (debug, info, warn, error) |

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

Processed intents are tracked in an in-memory `Map<intentId, timestamp>` to prevent duplicate processing.

### TTL-based pruning

Processed intent entries expire after `INTENT_TTL_MS` (default: 1 hour). Expired entries are pruned on each poll cycle. This means:

- An intent processed at 10:00 will be pruned at 11:00
- If the same intent event appears again after pruning, the relayer will attempt to re-process it
- On-chain guards (`EIntentAlreadyExecuted`, `AlreadyExecuted`) prevent actual double-execution

Set `INTENT_TTL_MS` higher if your relayer restarts frequently and you see unnecessary retry attempts.

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
| `bosphor_relayer_checkpoint_cursor_lag` | gauge | — | Latest Sui checkpoint minus the processed cursor |
| `bosphor_relayer_walrus_upload_seconds` | histogram | — | Walrus upload duration in seconds |

The `path` label distinguishes the two ways an intent is detected: `evm` (polled directly from the EVM adapter) and `sui_lz` (received on Sui via LayerZero). A rising `checkpoint_cursor_lag` indicates the relayer is falling behind the Sui chain tip.

## Walrus upload

The relayer uploads intent payloads to Walrus using the `@mysten/walrus` SDK's `writeBlob()` method. The SDK manages sliver distribution, certification, retries, and epoch management natively.

- All blobs are stored as **deletable**
- Blob ownership is transferred to the relayer's Sui address
- Storage duration is configured via `WALRUS_STORE_EPOCHS` (default: 5 epochs)
- The upload relay is configured via `WALRUS_RELAY_URL` in `SuiService`

## Error handling

| Scenario | Behavior |
|----------|----------|
| Intent deadline expired | Skipped, marked as processed |
| ABI decode failure | Marked as processed, not retried |
| Walrus upload failure | NOT marked as processed, retried on next poll |
| Sui TX failure | NOT marked as processed, retried on next poll |
| LZ fee quote failure | Falls back to default 0.5 SUI fee |

## Related

- [Architecture](architecture.md) for the full message flow
- [Contract Interface](contract-interface.md) for Sui function signatures
- [Deployment](deployment.md) for initial setup
- [Testing](testing.md) for running relayer unit tests
