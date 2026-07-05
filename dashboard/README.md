# Dashboard — status.bosphor.xyz

Static site served by Cloudflare Pages at `https://status.bosphor.xyz`.

`index.html` is a branded placeholder that proves the delivery pipeline (Pages +
custom domain + TLS) end to end. The full live dashboard (per-hop intent feed,
KPIs, component health) replaces it once built; it consumes the relayer's public
API at `https://api.bosphor.xyz` (see `../cloudflared`).

## Create the Pages project (one-time, Cloudflare dashboard)

1. **Workers & Pages → Create → Pages → Upload assets** (or connect the repo and
   set the build output directory to `dashboard`).
2. Name the project (e.g. `bosphor-status`) and upload this `dashboard/` folder
   (just `index.html` for the placeholder).
3. **Custom domains → Set up a custom domain → `status.bosphor.xyz`.** The DNS
   record is created automatically because `bosphor.xyz` is already on Cloudflare.
4. Verify: `https://status.bosphor.xyz` serves the placeholder over TLS.

No inbound port and no VPS involvement: Pages is hosted on Cloudflare's edge.
