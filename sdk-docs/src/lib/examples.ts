/**
 * The Examples gallery. One entry per starter repo, SDK script, reference
 * integration, and recipe. The gallery component renders these as filterable
 * cards, and llms.txt / the page's markdown twin render them as a plain list, so
 * the two never drift.
 */

export type ExampleChain = 'EVM' | 'Solana';
export type ExampleType = 'Starter' | 'Script' | 'Reference integration' | 'Recipe';

export interface ExampleLink {
  kind: 'github' | 'demo' | 'docs';
  label: string;
  href: string;
}

export interface Example {
  title: string;
  description: string;
  type: ExampleType;
  chains: ExampleChain[];
  tags: string[];
  links: ExampleLink[];
}

export const exampleTypes: ExampleType[] = ['Starter', 'Script', 'Reference integration', 'Recipe'];
export const exampleChains: ExampleChain[] = ['EVM', 'Solana'];

const sdkBlob = 'https://github.com/riva-labs/bosphor/blob/main/sdk/examples';

export const examples: Example[] = [
  {
    title: 'EVM starter',
    description:
      'Store a file from an Ethereum Sepolia wallet and get a verified proof back: quote, paid store with live progress, and refund scripts in about 100 lines of TypeScript.',
    type: 'Starter',
    chains: ['EVM'],
    tags: ['ethers v6', 'storePriced', 'quote', 'refund', 'appId'],
    links: [
      { kind: 'github', label: 'GitHub', href: 'https://github.com/riva-labs/bosphor-evm-starter' },
      { kind: 'docs', label: 'EVM guide', href: '/docs/guides/evm' },
    ],
  },
  {
    title: 'Solana starter',
    description:
      'Store a file from a Solana devnet keypair with a live LayerZero fee quote, a paid store with progress, and a refund script for expired escrows.',
    type: 'Starter',
    chains: ['Solana'],
    tags: ['@solana/web3.js', 'storePriced', 'quote', 'refund', 'appId'],
    links: [
      { kind: 'github', label: 'GitHub', href: 'https://github.com/riva-labs/bosphor-solana-starter' },
      { kind: 'docs', label: 'Solana guide', href: '/docs/guides/solana' },
    ],
  },
  {
    title: 'Demo dApp',
    description:
      'A full browser app on the SDK: sign in, pick a file, and watch a real EVM or Solana round-trip complete, with a Drive-style list of everything you stored.',
    type: 'Reference integration',
    chains: ['EVM', 'Solana'],
    tags: ['browser', 'wallet', 'progress UI', 'live testnet'],
    links: [
      { kind: 'demo', label: 'Live demo', href: 'https://demo.bosphor.xyz' },
      { kind: 'docs', label: 'dApp tutorial', href: '/docs/guides/dapp-tutorial' },
    ],
  },
  {
    title: 'Paid store (EVM script)',
    description:
      'Single-file script: preview the all-in quote, then run storePriced() to escrow, store, and wait for the verified proof on Sepolia.',
    type: 'Script',
    chains: ['EVM'],
    tags: ['storePriced', 'priceQuote', 'Node'],
    links: [
      { kind: 'github', label: 'store-file-priced.evm.ts', href: `${sdkBlob}/store-file-priced.evm.ts` },
      { kind: 'docs', label: 'Pay for storage', href: '/docs/guides/pay-for-storage' },
    ],
  },
  {
    title: 'Paid store (Solana script)',
    description:
      'The same paid flow from a Solana devnet keypair: quote in SOL, escrow into the per-intent vault, and await the proof.',
    type: 'Script',
    chains: ['Solana'],
    tags: ['storePriced', 'priceQuote', 'Node'],
    links: [
      { kind: 'github', label: 'store-file-priced.solana.ts', href: `${sdkBlob}/store-file-priced.solana.ts` },
      { kind: 'docs', label: 'Pay for storage', href: '/docs/guides/pay-for-storage' },
    ],
  },
  {
    title: 'Free testnet store (EVM script)',
    description:
      'The one-call store() flow on Sepolia, paying only the LayerZero fee. Testnet only, for quick experiments.',
    type: 'Script',
    chains: ['EVM'],
    tags: ['store', 'Node'],
    links: [
      { kind: 'github', label: 'store-file.evm.ts', href: `${sdkBlob}/store-file.evm.ts` },
      { kind: 'docs', label: 'EVM guide', href: '/docs/guides/evm' },
    ],
  },
  {
    title: 'Free testnet store (Solana script)',
    description:
      'The same one-call store() flow from a Solana devnet keypair, with the program id and LayerZero accounts from the TESTNET preset.',
    type: 'Script',
    chains: ['Solana'],
    tags: ['store', 'Node'],
    links: [
      { kind: 'github', label: 'store-file.solana.ts', href: `${sdkBlob}/store-file.solana.ts` },
      { kind: 'docs', label: 'Solana guide', href: '/docs/guides/solana' },
    ],
  },
  {
    title: 'Store a file from a React dApp',
    description:
      'Connect an injected wallet, switch it to Sepolia, show the price before the wallet prompt, then pay, upload, and wait for the proof.',
    type: 'Recipe',
    chains: ['EVM'],
    tags: ['React', 'injected wallet', 'priceQuote', 'submitPaid'],
    links: [{ kind: 'docs', label: 'Read the recipe', href: '/docs/examples/react-injected-wallet' }],
  },
  {
    title: 'Show store progress in your UI',
    description:
      'Turn onProgress events into status lines with explorer links as soon as the intent is on-chain, and wrap it in a React hook.',
    type: 'Recipe',
    chains: ['EVM', 'Solana'],
    tags: ['onProgress', 'React', 'UX'],
    links: [{ kind: 'docs', label: 'Read the recipe', href: '/docs/examples/store-progress' }],
  },
  {
    title: 'Quote without a wallet on your backend',
    description:
      'Serve live EVM and Solana prices from a server route with quoteEvmStore and quoteSolanaStore, with bigints safely encoded as JSON.',
    type: 'Recipe',
    chains: ['EVM', 'Solana'],
    tags: ['quoteEvmStore', 'quoteSolanaStore', 'backend'],
    links: [{ kind: 'docs', label: 'Read the recipe', href: '/docs/examples/backend-quote' }],
  },
  {
    title: 'Refund an expired escrow',
    description:
      'Read an intent’s escrow, tell released from pending, and refund it once the deadline passes, on EVM (refund + withdraw) and Solana.',
    type: 'Recipe',
    chains: ['EVM', 'Solana'],
    tags: ['getEscrow', 'refund', 'withdraw', 'refundEscrow'],
    links: [{ kind: 'docs', label: 'Read the recipe', href: '/docs/examples/refund-expired-escrow' }],
  },
  {
    title: 'Attribute your app’s traffic with appId',
    description:
      'Name your app once so the relayer records it on every quote and upload, from the clients, the quote helpers, or raw HTTP.',
    type: 'Recipe',
    chains: ['EVM', 'Solana'],
    tags: ['appId', 'X-Bosphor-App', 'attribution'],
    links: [{ kind: 'docs', label: 'Read the recipe', href: '/docs/examples/app-id' }],
  },
];

/** The gallery as markdown, for llms-full.txt and the page's .md twin. */
export function examplesMarkdown(siteUrl: string): string {
  const abs = (href: string) => (href.startsWith('/') ? `${siteUrl}${href}` : href);
  return exampleTypes
    .map((type) => {
      const items = examples.filter((e) => e.type === type);
      const lines = items.map((e) => {
        const links = e.links.map((l) => `[${l.label}](${abs(l.href)})`).join(', ');
        return `- **${e.title}** (${e.chains.join(', ')}): ${e.description} Links: ${links}.`;
      });
      return `## ${type === 'Reference integration' ? 'Reference integrations' : `${type}s`}\n\n${lines.join('\n')}`;
    })
    .join('\n\n');
}
