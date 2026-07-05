# Dashboard — status.bosphor.xyz

Static site served on Cloudflare Workers static assets at
`https://status.bosphor.xyz` (project `bosphor-status`).

`public/index.html` is a branded placeholder that proves the delivery pipeline
(Workers + custom domain + TLS) end to end. The full live dashboard (per-hop
intent feed, KPIs, component health) replaces it once built; it consumes the
relayer's public API at `https://api.bosphor.xyz` (see `../cloudflared`).

## Layout

- `public/` — the static assets that get deployed (just `index.html` for now).
- `wrangler.jsonc` — Workers static-assets config (`assets.directory: public`).

## Deployment

The `bosphor-status` project is connected to this Git repo with:

- **Root directory:** `/dashboard`
- **Build command:** none (static site)
- **Deploy command:** `npx wrangler deploy` (reads `wrangler.jsonc`)
- **Production branch:** `main`

Every push to `main` that touches `dashboard/` redeploys automatically. No
inbound port and no VPS involvement: it runs on Cloudflare's edge.

The custom domain `status.bosphor.xyz` is attached in the project's Domains tab
(DNS is created automatically because `bosphor.xyz` is already on Cloudflare).
