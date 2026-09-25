export const appName = 'Bosphor Docs';
export const docsRoute = '/docs';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';

/**
 * Public origin of the portal, used for canonical URLs, the sitemap, robots and
 * structured data. It stays on sdk.bosphor.xyz until the docs.bosphor.xyz
 * cutover, which changes it here in one place.
 */
export const siteUrl = 'https://sdk.bosphor.xyz';

export const tagline = 'Making Permanence Portable';

export const siteDescription =
  'Developer portal for Bosphor: store a file on Walrus from an EVM or Solana wallet, over LayerZero, with a verifiable proof back on the origin chain.';

export const links = {
  github: 'https://github.com/riva-labs/bosphor',
  npm: 'https://www.npmjs.com/package/@bosphor/sdk',
  status: 'https://status.bosphor.xyz',
  demo: 'https://demo.bosphor.xyz',
  site: 'https://bosphor.xyz',
};

export const gitConfig = {
  user: 'riva-labs',
  repo: 'bosphor',
  branch: 'main',
};
