// Single source of truth for every URL the portal took over.
//
// Two sites were merged into this one:
//   - docs.bosphor.xyz, the retired Docusaurus site (`website/`). Its docs were
//     served at the root (routeBasePath '/'), so each page lived at /<doc id>.
//   - sdk.bosphor.xyz, the previous Fumadocs site (this folder). Its pages lived
//     under /docs and some of them moved into section folders.
//
// The Worker in worker/index.mjs answers every path below with a 301 to its new
// home, and scripts/check-redirects.mjs fails the build if a target does not
// exist in the static export. Add an entry here whenever a page moves.

/** Old docs.bosphor.xyz (Docusaurus) path -> new portal path. */
export const legacyDocsSite = {
  // intro.md had `slug: /`. The portal home at / replaces it, so it is not a
  // redirect; /intro is kept for links that used the doc id.
  '/intro': '/docs',
  '/quickstart': '/docs/quickstart',
  '/glossary': '/docs/protocol/glossary',
  '/architecture': '/docs/protocol/architecture',
  '/lz-verification-flow': '/docs/protocol/lz-verification-flow',
  '/security-model': '/docs/protocol/security-model',
  '/payment-flow': '/docs/guides/pay-for-storage',
  '/contract-interface': '/docs/contracts/evm-adapter',
  '/integration-checklist': '/docs/guides/integration-checklist',
  '/dapp-tutorial': '/docs/guides/dapp-tutorial',
  '/public-api': '/docs/api',
  '/self-hosting': '/docs/protocol/self-hosting',
  '/deployment': '/docs/protocol/deployment',
  '/relayer': '/docs/protocol/relayer',
  '/canary': '/docs/protocol/canary',
  '/chaos-harness': '/docs/protocol/chaos-harness',
  '/testing': '/docs/protocol/testing',
  '/benchmarks': '/docs/protocol/benchmarks',
  '/multichain-testing': '/docs/protocol/multichain-testing',
  '/troubleshooting': '/docs/protocol/troubleshooting',
  '/commitment-format': '/docs/contracts/commitment-format',
  '/sui-executor': '/docs/contracts/sui-executor',
  '/known-limitations': '/docs/protocol/known-limitations',
  '/changelog': '/docs/changelog/milestones',
  // docusaurus-search-local page.
  '/search': '/docs',
};

/** Old sdk.bosphor.xyz page path -> new portal path (moved pages only). */
export const legacySdkSite = {
  '/docs/pay-for-storage': '/docs/guides/pay-for-storage',
  '/docs/evm': '/docs/guides/evm',
  '/docs/solana': '/docs/guides/solana',
  '/docs/errors': '/docs/guides/errors',
  '/docs/resume': '/docs/guides/resume',
  '/docs/faq': '/docs/guides/faq',
  // The hand-written codec page became a page of the generated Core reference.
  '/docs/reference/codec': '/docs/reference/core/commitment-codec',
};

/**
 * Old sdk.bosphor.xyz paths that kept their address. They need no redirect on
 * this host, but they are listed so the check proves they still resolve, and so
 * the sdk.bosphor.xyz -> docs.bosphor.xyz host move covers them.
 */
export const unchangedSdkPaths = [
  '/',
  '/docs',
  '/docs/quickstart',
  '/docs/how-it-works',
  '/docs/changelog',
  '/docs/reference/testnet',
  '/docs/reference/core',
  '/docs/reference/evm',
  '/docs/reference/solana',
  '/llms.txt',
  '/llms-full.txt',
  '/sitemap.xml',
  '/robots.txt',
];

/** Per-page Markdown and OG image routes follow their page. */
function derivedRoutes(pageMap) {
  const out = {};
  for (const [from, to] of Object.entries(pageMap)) {
    if (!from.startsWith('/docs/') || !to.startsWith('/docs/')) continue;
    const oldSlug = from.slice('/docs/'.length);
    const newSlug = to.slice('/docs/'.length);
    out[`/llms.mdx/docs/${oldSlug}/content.md`] = `/llms.mdx/docs/${newSlug}/content.md`;
    out[`/og/docs/${oldSlug}/image.png`] = `/og/docs/${newSlug}/image.png`;
  }
  return out;
}

/** Every path that 301s, old path -> new path. */
export const redirects = {
  ...legacyDocsSite,
  ...legacySdkSite,
  ...derivedRoutes(legacySdkSite),
};

/** Strip a trailing slash and a trailing `.html` so /x, /x/ and /x.html match. */
export function normalizePath(pathname) {
  let p = pathname;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  if (p.endsWith('/index.html')) p = p.slice(0, -'/index.html'.length) || '/';
  else if (p.endsWith('.html')) p = p.slice(0, -'.html'.length);
  return p || '/';
}

/** The new path for an old one, or null when the path did not move. */
export function resolveRedirect(pathname) {
  const target = redirects[normalizePath(pathname)];
  return target ?? null;
}
