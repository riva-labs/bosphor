# Bosphor developer portal

The single docs site for Bosphor: get started, guides, SDK and API reference,
contracts, examples, playground, protocol, and changelog. Built with
[Fumadocs](https://fumadocs.dev) on Next.js as a static export, served by a
Cloudflare Worker (`wrangler.jsonc`).

## Develop

```bash
npm ci
npm run dev        # http://localhost:3000
npm run build      # generate the SDK reference, static export to out/, then the checks below
npm start          # serve out/ locally
npm run preview    # serve out/ through the redirect Worker (wrangler dev)
```

`npm run build` fails when:

- a page has no markdown twin: after `next build`, `scripts/markdown-aliases.mjs`
  writes every page to its URL plus `.md` (`/docs/quickstart.md`) for AI
  assistants, and `llms.txt` links to those,
- an internal link or `#anchor` on any page is broken (`scripts/check-links.mjs`),
- a retired URL does not land on a real page (`scripts/check-redirects.mjs`),
- the redirect Worker tests fail (`scripts/test-worker.mjs`).

## Layout

| Path | What it holds |
|------|---------------|
| `content/docs/` | Pages (`.mdx`). Each top-level folder with `"root": true` in its `meta.json` is a section tab in the top navbar (Fumadocs Notebook layout; pages must import from `fumadocs-ui/layouts/notebook/page`). `(get-started)` is a group folder, so its pages live at `/docs`, `/docs/quickstart`, `/docs/how-it-works`. |
| `src/app/(home)` | The portal home page. |
| `src/components/` | MDX components (`AgentPrompt`, `ExamplesGallery`, `Mermaid`), page actions, footer, and the search dialog. |
| `src/lib/examples.ts` | The Examples gallery entries (also rendered as markdown for `llms-full.txt`). |
| `src/lib/llms.ts` | `llms.txt` and `llms-full.txt`, built from the page tree. |
| `src/app/global.css` | The brand theme (Fumadocs color variables, fonts). |
| `src/lib/shared.ts` | Site name, public URL (`siteUrl`), and external links. |
| `redirects/map.mjs` | Every retired URL and its new page. |
| `worker/index.mjs` | The Worker that 301s retired URLs and serves the assets. |

## SDK reference

The `@bosphor/sdk` reference under `content/docs/reference/{core,evm,solana}/` is
generated from `sdk/src` by `scripts/gen-sdk-reference.mjs` (TypeDoc with
`typedoc-plugin-markdown`). `npm run build` and `npm run dev` run it first, and
`npm run gen:sdk-ref` runs it alone. The output is git-ignored, so the reference
always matches the source: to change it, edit the TSDoc comments in `sdk/src`.
It needs the SDK dependencies (`cd ../sdk && npm ci`).

- One folder per entry point (`@bosphor/sdk`, `/evm`, `/solana`) and one page
  per export group: Clients, Functions, Commitment codec, Errors, Constants,
  Types. A symbol exported from several entry points is documented once, where
  it is defined, and linked from the others.
- `@internal` and private members are left out.
- The generation fails on a TypeDoc warning (for example a broken `{@link}`) and
  on a public export without a TSDoc summary.

`reference/index.mdx` (install and entry points) and `reference/testnet.mdx` stay
hand-written.

## Moving a page

Move the file, then add `old path -> new path` to `redirects/map.mjs`. The build
proves the target exists.

## Domain cutover

The portal still serves at sdk.bosphor.xyz. At the docs.bosphor.xyz cutover:
set `siteUrl` in `src/lib/shared.ts`, add the route in `wrangler.jsonc`, and set
the Worker var `CANONICAL_ORIGIN=https://docs.bosphor.xyz` so other hosts 301 to
it.
