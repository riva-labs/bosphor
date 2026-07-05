---
sidebar_position: 6.5
title: Canary Monitoring
---

# Canary Monitoring

The Bosphor canary is a standalone service that runs a continuous synthetic end-to-end round-trip: it submits a real intent on EVM, waits for the relayer to fulfill it on Sui, and confirms the execution proof arrives back on EVM. It is the primary signal that the whole cross-chain path is healthy, not just that individual services are up.

The canary runs as its own container (`canary` in the compose stack) and exposes Prometheus metrics on port `9300`.

## Preflight guard

Every synthetic round-trip costs real testnet gas. Before each probe the canary runs a preflight check on the sender wallet and the network, and skips the tick (rather than submitting) when either of two conditions holds:

| Reason | Condition | Why it skips |
|--------|-----------|--------------|
| `low_balance` | Balance below `CANARY_MIN_BALANCE_ETH` | An empty sender reverts every `submitIntent` with `INSUFFICIENT_FUNDS`. Skipping avoids a flood of failed submits and surfaces the real problem: the wallet needs a refill. |
| `high_gas` | Gas price above `CANARY_MAX_GAS_GWEI` | A base-fee spike (Sepolia has hit 400+ gwei versus ~2 gwei normal) makes a single probe cost 100x and drains the buffer in hours. Skipping protects the funds; the next tick retries once gas settles. |

A skipped tick still refreshes the balance and gas gauges, so monitoring always has fresh values. Balance is checked before gas: an empty wallet needs a human to refill it, whereas high gas resolves on its own.

## Configuration

| Variable | Default | Meaning |
|----------|---------|---------|
| `CANARY_MIN_BALANCE_ETH` | `0.005` | Skip a probe when the sender balance is below this (roughly ten probes of runway). |
| `CANARY_MAX_GAS_GWEI` | `50` | Skip a probe when network gas exceeds this. Normal Sepolia gas is ~2 gwei. |
| `CANARY_INTERVAL_MS` | `900000` | Interval between round-trips (15 min). |
| `CANARY_PORT` | `9300` | Port for the `/metrics` and `/health` endpoints. |

## Metrics endpoint

The canary exposes Prometheus metrics at `GET /metrics` on `CANARY_PORT` (default 9300). Alongside the default `prom-client` process metrics it emits:

| Metric | Type | Labels | Meaning |
|--------|------|--------|---------|
| `bosphor_canary_roundtrip_total` | counter | `result` (`success`/`failure`) | Synthetic round-trips by outcome |
| `bosphor_canary_roundtrip_duration_seconds` | histogram | — | Full round-trip duration |
| `bosphor_canary_stage_duration_seconds` | histogram | `stage` (`forward_delivery`/`return_delivery`) | Per-leg duration |
| `bosphor_canary_last_success_timestamp_seconds` | gauge | — | Unix time of the last successful round-trip |
| `bosphor_canary_wallet_balance_eth` | gauge | — | Sender wallet balance in ETH |
| `bosphor_canary_gas_price_gwei` | gauge | — | Current network gas price in gwei |
| `bosphor_canary_skipped_total` | counter | `reason` (`low_balance`/`high_gas`) | Probes skipped by the preflight guard |

## Alerts

The provided `monitoring/alerts.yml` ships these canary rules:

| Alert | Severity | Fires when |
|-------|----------|-----------|
| `BosphorCanaryDown` | critical | The canary is not scrapable for 2m |
| `BosphorCanaryRoundTripFailing` | warning | Two or more round-trips fail in 20m |
| `BosphorCanaryRoundTripStale` | critical | No successful round-trip in over 40m |
| `BosphorCanaryWalletLow` | warning | Wallet balance below 0.05 ETH (refill soon) |
| `BosphorCanaryWalletCritical` | critical | Wallet balance below 0.01 ETH (probes skipping) |
| `BosphorCanaryGasSpikeSkipping` | warning | Three or more probes skipped for high gas in 30m |

When a `high_gas` skip alert is active, treat a following staleness alert as a gas spike rather than a real outage: the canary is protecting funds, not detecting a broken path.

## Refilling the wallet

When `BosphorCanaryWalletLow` or `BosphorCanaryWalletCritical` fires, top up the canary sender with Sepolia ETH (and Sui testnet gas on the destination side). No restart is needed. The preflight guard clears on the next tick once the balance is back above `CANARY_MIN_BALANCE_ETH`.

## Error tracking (Sentry)

The canary reports failed probes to Sentry when `SENTRY_DSN` is set, tagged with the failing intent id and the stage that failed (`submit` or `return`), alongside unexpected runtime errors. It shares the relayer's `SENTRY_DSN` / `SENTRY_ENVIRONMENT` environment. Leave `SENTRY_DSN` empty to disable; the canary runs unchanged without it.

## Related

- [Relayer Operator Guide](relayer.md) for the service the canary exercises
- [Architecture](architecture.md) for the full message flow
