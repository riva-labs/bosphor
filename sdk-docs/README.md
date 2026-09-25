# Bosphor developer portal

The single docs site for Bosphor: get started, guides, SDK and API reference,
contracts, examples, playground, protocol, and changelog. Built with
[Fumadocs](https://fumadocs.dev) on Next.js as a static export, served by a
Cloudflare Worker (`wrangler.jsonc`).

## Develop

```bash
npm ci
npm run dev        # http://localhost:3000
npm run build      # static export to out/, then the checks below
npm start          # serve out/ locally
npm run preview    # serve out/ through the redirect Worker (wrangler dev)
```

`npm run build` fails when:

- an internal link or `#anchor` on any page is broken (`scripts/check-links.mjs`),
- a retired URL does not land on a real page (`scripts/check-redirects.mjs`),
- the redirect Worker tests fail (`scripts/test-worker.mjs`).

## Layout

| Path | What it holds |
|------|---------------|
| `content/docs/` | Pages (`.mdx`). Each top-level folder with `"root": true` in its `meta.json` is a section tab. `(get-started)` is a group folder, so its pages live at `/docs`, `/docs/quickstart`, `/docs/how-it-works`. |
| `src/app/(home)` | The portal home page. |
| `src/components/` | MDX components (`AgentPrompt`, `Mermaid`, type tables) and the search dialog. |
| `src/app/global.css` | The brand theme (Fumadocs color variables, fonts). |
| `src/lib/shared.ts` | Site name, public URL (`siteUrl`), and external links. |
| `redirects/map.mjs` | Every retired URL and its new page. |
| `worker/index.mjs` | The Worker that 301s retired URLs and serves the assets. |

## Moving a page

Move the file, then add `old path -> new path` to `redirects/map.mjs`. The build
proves the target exists.

## Domain cutover

The portal still serves at sdk.bosphor.xyz. At the docs.bosphor.xyz cutover:
set `siteUrl` in `src/lib/shared.ts`, add the route in `wrangler.jsonc`, and set
the Worker var `CANONICAL_ORIGIN=https://docs.bosphor.xyz` so other hosts 301 to
it.
