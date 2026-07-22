---
sidebar_position: 9
title: Public Intent Feed API
---

# Public Intent Feed API

Bosphor exposes a read-only HTTP API that surfaces the live cross-chain lifecycle of every intent the relayer handles. It powers the public status dashboard and lets integrators build their own views without touching internal metrics. The API serves real data only: when the backing store is unavailable it returns an explicit error, never a fabricated feed.

The feed is served by the relayer and, in the deployed testnet, is reachable at `https://api.bosphor.xyz`.

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

## Configuration

The feed is backed by Postgres. Set `DATABASE_URL` in the relayer environment to enable durable storage. When it is unset, the relayer falls back to an in-memory store, which is intended for local development only and does not survive restarts.
