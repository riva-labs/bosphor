---
sidebar_position: 9
title: Public Intent Feed API
---

# Public Intent Feed API

Bosphor exposes a read-only HTTP API that surfaces the live cross-chain lifecycle of every intent the relayer handles. It powers the public status dashboard and lets integrators build their own views without touching internal metrics. The API serves real data only: when the backing store is unavailable it returns an explicit error, never a fabricated feed.

The relayer HTTP API has two integration surfaces: the read-only intent feed documented here, and the [blob ingest](#blob-ingest-out-of-band) endpoint that receives the file bytes out-of-band.

The relayer base URL is `https://api.bosphor.xyz/testnet` on testnet and `https://api.bosphor.xyz` on mainnet. The examples on this page use the testnet path.

## The intent lifecycle

Each intent travels six hops on its cross-chain round trip. The relayer records each hop as it observes it:

| Hop | Meaning | Witnessed on |
|-----|---------|--------------|
| `submitted` | Intent submitted to the EVM adapter | EVM (`IntentSubmitted`) |
| `received` | Intent delivered to Sui over LayerZero | Sui (`IntentReceived`) |
| `stored_walrus` | Payload uploaded to Walrus | Walrus |
| `recorded_sui` | Storage recorded on Sui (`execute_store`) | Sui |
| `proof_sent` | Execution proof sent back over LayerZero | Sui |
| `confirmed` | Proof landed and execution confirmed on EVM | EVM (`IntentExecuted`) |

An intent's `status` is the furthest hop it has reached. The `stored_walrus` hop carries the Walrus `blobId`, the Sui object id of the blob, and the storage expiry epoch, so a consumer can deep-link the payload on Walruscan.

## `GET /public/intents`

Returns the most recent intents, newest first.

Query parameters:

| Parameter | Type | Default | Notes |
|-----------|------|---------|-------|
| `limit` | integer | `50` | Clamped to the range 1 to 200 |

Example response:

```json
{
  "count": 1,
  "intents": [
    {
      "intentId": "0xab...",
      "status": "confirmed",
      "sender": "0x1111...",
      "blobId": "blob-xyz",
      "suiObjectId": "0xobj...",
      "endEpoch": 42,
      "createdAt": 1751731200000,
      "updatedAt": 1751731440000,
      "hops": [
        { "hop": "submitted", "timestamp": 1751731200000, "txHash": "0x..." },
        { "hop": "received", "timestamp": 1751731230000 },
        { "hop": "stored_walrus", "timestamp": 1751731260000, "txHash": "0x..." },
        { "hop": "recorded_sui", "timestamp": 1751731290000, "txHash": "0x..." },
        { "hop": "proof_sent", "timestamp": 1751731320000, "txHash": "0x..." },
        { "hop": "confirmed", "timestamp": 1751731440000, "txHash": "0x..." }
      ]
    }
  ]
}
```

Timestamps are epoch milliseconds. `txHash` holds the EVM transaction hash or Sui transaction digest that produced the hop, when one is known.

### Error behaviour

If the feed store is unavailable, the endpoint responds `503 Service Unavailable` rather than returning stale or fabricated data. Consumers should surface this as an explicit "feed unavailable" state.

### CORS

The API is read-only and restricted to the dashboard origin via CORS. Set `DASHBOARD_ORIGIN` in the relayer environment to the origin that is allowed to read it (defaults to `https://status.bosphor.xyz`).

## Blob ingest (out-of-band)

This is the M3 data-independent-cost design in practice. Only the 50-byte commitment travels cross-chain; the file bytes go out-of-band to the relayer, which is held to the commitment. After `submitIntent` returns an `intentId`, upload the exact bytes you committed to the relayer so it can store them on Walrus and fulfill the intent.

### `POST {relayerBaseUrl}/blob/{intentId}`

Send the raw blob bytes as the request body. The relayer recomputes the Walrus blob id and size from the body and binds them to the on-chain commitment recorded for `intentId`.

- **Path parameter**: `intentId`, the 0x-prefixed 32-byte intent id returned by `submitIntent`.
- **Headers**: `content-type: application/octet-stream`.
- **Body**: the raw blob bytes (not base64, not multipart, not JSON).

Base URL: `https://api.bosphor.xyz/testnet` on testnet, `https://api.bosphor.xyz` on mainnet.

```bash
curl -X POST \
  -H "content-type: application/octet-stream" \
  --data-binary @./file.bin \
  "https://api.bosphor.xyz/testnet/blob/0xabc...def"
```

On success the relayer responds `200`/`201` with a small JSON ack:

```json
{ "intentId": "0xabc...def", "blobId": "blob-xyz", "size": 1024 }
```

### Rejections

Each rejection maps to a precise HTTP status so a client can react without parsing the message:

| Status | Meaning |
|--------|---------|
| `400 Bad Request` | Body is empty or not raw bytes |
| `404 Not Found` | No pending intent for that id (or the relayer has not seen it yet) |
| `409 Conflict` | The intent is already executed |
| `410 Gone` | The intent deadline has passed |
| `413 Payload Too Large` | Body exceeds the ingest cap (`MAX_INGEST_BLOB_BYTES`, default 10 MiB) |
| `422 Unprocessable Entity` | The recomputed blob id or size does not match the commitment |
| `503 Service Unavailable` | The relayer is not ready or is shedding load (backpressure); honor `Retry-After` |

A `404` right after submitting is usually a timing race: the relayer has not yet observed the `IntentSubmitted` event. Retry with backoff. A `422` means the bytes you uploaded are not the bytes you committed to; recompute the blob id from the same data and resubmit.

The `@bosphor/sdk` `store()` flow performs this upload for you (`client.upload(intentId, data)` is also exposed as an escape hatch). See [sdk.bosphor.xyz](https://sdk.bosphor.xyz).

## Configuration

The feed is backed by Postgres. Set `DATABASE_URL` in the relayer environment to enable durable storage. When it is unset, the relayer falls back to an in-memory store, which is intended for local development only and does not survive restarts.
