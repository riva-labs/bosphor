# Monitoring

Prometheus + Grafana over the relayer, canary, and the two self-operated DVNs.
All targets are scraped from `prometheus.yml`; dashboards are provisioned from
`grafana/dashboards/` (they reload on their own, no import needed).

## Mission Control (start here)

`grafana/dashboards/bosphor-overview.json` (uid `bosphor-overview`, title
**Bosphor Mission Control**) is the single at-a-glance page and is set as the
Grafana home dashboard. Top to bottom:

- **Service health** - canary (EVM, Solana), both relayers, both DVNs. Green = up.
- **Canary** - synthetic round-trip success rate (24h) and p50/p95 latency.
- **Relayers** - intents processed, Sui checkpoint cursor lag, LZ proof sends.
- **Funding & balances** - canary wallets (ETH/SOL), relayer WAL/SUI, gas price.
- **Durable store queue** - active intents, queued bytes, dead-letters.

Component detail dashboards (`bosphor-canary`, `bosphor-relayer`, `bosphor-dvn`,
`bosphor-testnet-history`) are linked from the overview's top-right menu.

## Relayer scrape port

The relayer serves `/metrics` only on its internal `METRICS_PORT` (default
9464), never on the public API port. Prometheus scrapes the mainnet relayer at
`relayer:9464` over the compose network. The testnet relayer runs in a separate
compose project, so its container port 9464 must be published on the host at
9465 (bound to the docker bridge, never routed through the tunnel or nginx);
Prometheus reaches it at `host.docker.internal:9465`.

The relayer dashboard's ops-ledger panels (ops by origin chain, cumulative
bytes, unique apps) read `storage_op_ledger` through the Bosphor Testnet
Postgres datasource.

## Access

- **Admin:** https://grafana.bosphor.xyz (login). Opens Mission Control by default.
- **Login-free (shareable):** Mission Control is exposed as a Grafana public
  dashboard with live data. The URL carries a secret access token, so it is not
  committed here. Print the current one with:

  ```bash
  ./scripts/grafana-apply.sh
  ```

## Durability

Dashboards are provisioned, so they always come back. But Grafana has **no
persistent volume**, so two things live only in Grafana's DB and reset when the
container is recreated:

1. the home dashboard preference, and
2. the public-dashboard access token (a recreate mints a new URL).

After any Grafana recreate, restore both with one idempotent command:

```bash
./scripts/grafana-apply.sh
```

## Operating the stack

Always bring the stack up with both compose files (another project on the host
holds ports 3000/9090; the overlay remaps Grafana to 3001 and Prometheus to
9091):

```bash
docker compose -f docker-compose.yml -f docker-compose.hosting.yml up -d
```

Never run `docker compose up -d grafana|prometheus` without `-f
docker-compose.hosting.yml` - it will try the base ports and fail.
