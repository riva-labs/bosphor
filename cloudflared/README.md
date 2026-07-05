# Cloudflare Tunnel — public relayer API

Exposes the Bosphor relayer's read-only public API as `https://api.bosphor.xyz`
without opening any inbound port on the VPS. `cloudflared` connects outbound to
the Cloudflare edge, so `walrus-portal` (:80), Grafana, and every other host
service are untouched. Grafana remains the operator layer, unchanged.

`api.bosphor.xyz` routes to the relayer on host port `3300`
(`bosphor-relayer-1: 3300->3000`). The public feed lives at
`GET /public/intents` and health at `GET /health`.

## Files

- `config.yml` — tunnel id + ingress rules (committed; no secrets).
- Secrets live only in `~/.cloudflared` on the host and are gitignored:
  - `cert.pem` — Cloudflare account certificate (from `tunnel login`).
  - `<tunnel-id>.json` — tunnel credentials (from `tunnel create`).

## One-time setup

`cloudflared` is installed at `~/.local/bin/cloudflared` (single static binary,
no root needed).

```bash
# 1. Authenticate (interactive; opens a browser URL). Pick the bosphor.xyz zone.
~/.local/bin/cloudflared tunnel login

# 2. Create the tunnel (writes ~/.cloudflared/<tunnel-id>.json).
~/.local/bin/cloudflared tunnel create bosphor-api

# 3. Copy this repo's config.yml to ~/.cloudflared/config.yml (or symlink).

# 4. Route the hostname to the tunnel (creates the CNAME on Cloudflare DNS).
~/.local/bin/cloudflared tunnel route dns bosphor-api api.bosphor.xyz
```

## Running (durable, no root)

The tunnel runs as a docker container on the host, consistent with the rest of
the deployment. `--user` matches the host user so the container can read the
`~/.cloudflared` mount; `--network host` lets it reach `localhost:3300`.

```bash
docker run -d --name bosphor-cloudflared --restart unless-stopped \
  --network host --user "$(id -u):$(id -g)" \
  -v "$HOME/.cloudflared:/etc/cloudflared:ro" \
  cloudflare/cloudflared:latest \
  tunnel --config /etc/cloudflared/config.yml run
```

Verify:

```bash
curl https://api.bosphor.xyz/health   # -> relayer health JSON over TLS
```

Logs: `docker logs bosphor-cloudflared`. Restart: `docker restart bosphor-cloudflared`.
