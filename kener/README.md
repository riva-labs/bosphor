# Kener — public status page for status.bosphor.xyz

Self-hosted [Kener](https://github.com/rajnandan1/kener) v4, replacing Uptime
Kuma. Prebuilt image, no source build. Redis (internal) + Kener with SQLite in a
named volume. Same delivery as before: the Cloudflare tunnel routes the hostname
to a host port, no inbound port opened on the VPS.

## Files

- `docker-compose.yml` — Redis + Kener. Kener on host port 3008.
- `.env.example` — `KENER_SECRET_KEY`, `ORIGIN`. Real values in gitignored `.env`.
- `theme.css` — Bosphor custom CSS (deep navy, grain, serif accent). Source of
  truth for the theme; applied into the DB (see below).

## Deploy

```bash
cp kener/.env.example kener/.env      # fill KENER_SECRET_KEY (openssl rand -base64 32) + ORIGIN
docker compose -f kener/docker-compose.yml --env-file kener/.env up -d
```

Kener answers on `http://<host>:3008`. First visit to `/account/signin` shows a
"Create Admin Account" form (name / email / password: 8+ chars, one upper, one
lower, one number). No email or magic-link needed.

## Bosphor branding

Most settings are set in the admin UI (Settings). The palette and typography
applied (brand: deep navy, no purple, functional blue for links/focus only):

- Status colors (light + dark): UP `#3D8B6B`, DOWN `#A84D4A`,
  DEGRADED `#9E8540`, MAINTENANCE `#4A8EC7`, ACCENT_FOREGROUND `#4A8EC7`.
- Font family `Instrument Sans`, cssSrc loads Instrument Sans + Instrument Serif
  + JetBrains Mono from Google Fonts.
- Default theme: dark.

The deep-navy background, grain, and serif-italic accent come from `theme.css`,
applied to Kener's `customCSS` site setting. Kener has no file mount for this, so
it lives in the DB. To (re)apply after editing `theme.css`:

```bash
docker cp kener/theme.css bosphor-kener:/tmp/theme.css
# CAST AS TEXT is REQUIRED: readfile() returns a BLOB, which Kener serializes
# into the page as a Uint8Array and breaks client JS (page stuck on skeletons).
docker exec bosphor-kener sqlite3 /app/database/kener.sqlite.db \
  "INSERT INTO site_data (key,value,data_type) VALUES ('customCSS', CAST(readfile('/tmp/theme.css') AS TEXT), 'string') \
   ON CONFLICT(key) DO UPDATE SET value=CAST(readfile('/tmp/theme.css') AS TEXT), updated_at=CURRENT_TIMESTAMP;"
docker restart bosphor-kener
```

## Monitors

Monitors live in the DB (SQLite volume), not in git. Add via the admin UI
(Monitors → Create) so the form produces the correct `type_data`; do not
hand-write it in SQL from scratch. To add many, create one in the UI, then clone
its row in SQL and `REPLACE` the url (and for a POST monitor, the method + body),
add a `pages_monitors` link (page_id=1), and `docker restart bosphor-kener`.

Current set (two categories):

Bosphor
- Bosphor — `https://api.bosphor.xyz/health` (relayer)
- Intent Lifecycle API — `https://api.bosphor.xyz/public/intents`
- Bosphor Website — `https://bosphor.xyz`

Dependencies (upstream chains/infra Bosphor relies on; public health endpoints,
not our keyed providers)
- Ethereum Sepolia RPC — `https://ethereum-sepolia-rpc.publicnode.com` (POST `eth_blockNumber`)
- Sui Testnet RPC — `https://fullnode.testnet.sui.io/health`
- Walrus Testnet — `https://aggregator.walrus-testnet.walrus.space/v1/api`
- LayerZero Scan API — `https://scan-testnet.layerzero-api.com/v1/swagger`

## Cutover from Uptime Kuma (after the page looks right)

1. Set `ORIGIN=https://status.bosphor.xyz` in `kener/.env`, then
   `docker compose -f kener/docker-compose.yml --env-file kener/.env up -d`.
2. Point the tunnel: in `../cloudflared/config.yml` route `status.bosphor.xyz`
   to `http://localhost:3008`, copy to `~/.cloudflared/config.yml`,
   `docker restart bosphor-cloudflared`.
3. Remove the `status.bosphor.xyz` custom domain from the Cloudflare Workers
   project `bosphor-status` so the tunnel CNAME is the sole owner.
4. Retire Kuma: remove its service from `../docker-compose*.yml`,
   `docker rm -f bosphor-uptime-kuma-1 && docker volume rm bosphor_uptime-kuma-data`.

Rollback: point the tunnel back to `http://localhost:3002` and restart cloudflared.
