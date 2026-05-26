---
sidebar_position: 6
title: Relayer Operator Guide
---

# Relayer Operator Guide

The Bosphor relayer is a NestJS service that bridges Sui and EVM. It polls both chains for events, uploads payloads to Walrus, executes storage intents on Sui, and sends execution proofs back to EVM via LayerZero.

## How it works

1. Polls Sui for `IntentReceived` events (delivered by LayerZero from EVM)
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
| `WALRUS_PUBLISHER_URL` | Walrus publisher endpoint |
| `WALRUS_AGGREGATOR_URL` | Walrus aggregator endpoint |

### Optional environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EVM_DST_EID` | `40161` | EVM destination endpoint ID for proof verification |
| `SUI_RPC_URL` | `https://fullnode.testnet.sui.io:443` | Sui RPC endpoint |
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

## Polling and deduplication

The relayer polls both chains every 5 seconds. Processed intents are tracked in an in-memory `Map<intentId, timestamp>` to prevent duplicate processing.

### TTL-based pruning

Processed intent entries expire after `INTENT_TTL_MS` (default: 1 hour). Expired entries are pruned on each poll cycle. This means:

- An intent processed at 10:00 will be pruned at 11:00
- If the same intent event appears again after pruning, the relayer will attempt to re-process it
- On-chain guards (`EIntentAlreadyExecuted`, `AlreadyExecuted`) prevent actual double-execution

Set `INTENT_TTL_MS` higher if your relayer restarts frequently and you see unnecessary retry attempts.

## Fee quoting

Before sending a proof back to EVM, the relayer quotes the LZ fee using `devInspect` simulation on Sui. The quoted fee gets a 10% buffer to account for gas price fluctuations.

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

## Walrus upload

The relayer uploads intent payloads to Walrus with retry logic:

- Max 3 attempts per upload
- 5xx errors trigger exponential backoff (2, 4, 8 seconds)
- 4xx errors fail immediately (no retry)
- 30-second timeout per attempt
- All blobs are stored as **deletable** with `send_object_to` set to the relayer's Sui address

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
