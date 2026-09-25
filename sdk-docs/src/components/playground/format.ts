// Pure helpers for the playground: formatting and the live code snippets. No SDK
// or chain library is imported here, so this stays in the page's first load.

export type Chain = 'evm' | 'solana';

/** App id the playground sends to the relayer (attribution only). */
export const PLAYGROUND_APP_ID = 'bosphor-playground';

/** Largest blob the hosted testnet relayer ingests (MAX_INGEST_BLOB_BYTES). */
export const MAX_BLOB_BYTES = 10 * 1024 * 1024;

export const MIN_EPOCHS = 1;
export const MAX_EPOCHS = 53;
export const DEFAULT_EPOCHS = 5;

/** Walrus testnet epochs last one day (mainnet epochs are two weeks). */
export const TESTNET_EPOCH_DAYS = 1;

export const CHAINS: Record<Chain, { label: string; network: string; symbol: string; decimals: number }> = {
  evm: { label: 'EVM', network: 'Ethereum Sepolia', symbol: 'ETH', decimals: 18 },
  solana: { label: 'Solana', network: 'Solana devnet', symbol: 'SOL', decimals: 9 },
};

export const SIZE_PRESETS: { label: string; bytes: number }[] = [
  { label: '1 KB', bytes: 1024 },
  { label: '100 KB', bytes: 100 * 1024 },
  { label: '1 MB', bytes: 1024 * 1024 },
  { label: '10 MB', bytes: MAX_BLOB_BYTES },
];

/** Format a smallest-unit amount (wei, lamports) as a decimal string. */
export function formatNative(amount: bigint, decimals: number, maxFraction = 6): string {
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction);
  frac = frac.replace(/0+$/, '');
  // Show at least one significant digit for tiny non-zero amounts.
  if (whole === 0n && frac === '' && abs > 0n) return `${neg ? '-' : ''}<0.${'0'.repeat(maxFraction - 1)}1`;
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

/** Group a byte count with underscores the way TypeScript numeric literals allow. */
function tsNumber(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '_');
}

export function shortHex(hex: string, head = 10, tail = 8): string {
  return hex.length <= head + tail + 1 ? hex : `${hex.slice(0, head)}...${hex.slice(-tail)}`;
}

export interface SnippetInput {
  chain: Chain;
  sizeBytes: number;
  epochs: number;
  fileName?: string;
}

/** The wallet-free quote call equivalent to what the playground just ran. */
export function quoteSnippet({ chain, sizeBytes, epochs, fileName }: SnippetInput): string {
  const size = `  sizeBytes: ${tsNumber(sizeBytes)},${fileName ? ` // ${fileName}` : ''}`;
  if (chain === 'evm') {
    return [
      "import { JsonRpcProvider } from 'ethers';",
      "import { TESTNET, quoteEvmStore } from '@bosphor/sdk/evm';",
      '',
      'const quote = await quoteEvmStore({',
      '  provider: new JsonRpcProvider(TESTNET.evm.rpcUrl),',
      size,
      `  epochs: ${epochs},`,
      "  appId: 'my-app', // optional attribution",
      '});',
      '',
      '// quote.totalNative is the wei to pay; quote.breakdown has the USD parts.',
    ].join('\n');
  }
  return [
    "import { Connection } from '@solana/web3.js';",
    "import { TESTNET, quoteSolanaStore } from '@bosphor/sdk/solana';",
    '',
    'const quote = await quoteSolanaStore({',
    "  connection: new Connection(TESTNET.solana.rpcUrl, 'confirmed'),",
    size,
    `  epochs: ${epochs},`,
    "  appId: 'my-app', // optional attribution",
    '});',
    '',
    '// quote.totalNative is in lamports. Install @layerzerolabs/lz-solana-sdk-v2',
    '// for the live LayerZero fee; without it the fee is a cap (forwardIsUpperBound).',
  ].join('\n');
}

/** The one-call paid store, as a dApp would run it from a browser wallet. */
export function storeSnippet({ chain, epochs }: SnippetInput): string {
  if (chain === 'evm') {
    return [
      "import { BrowserProvider } from 'ethers';",
      "import { createBosphorClientFromSigner, walrusBlobUrl } from '@bosphor/sdk/evm';",
      '',
      'const signer = await new BrowserProvider(window.ethereum).getSigner();',
      "const client = await createBosphorClientFromSigner(signer, { appId: 'my-app' });",
      '',
      'const { intentId, blobId, txHash } = await client.storePriced(bytes, {',
      `  epochs: ${epochs},`,
      '  onProgress: (e) => console.log(e.step), // encoded, quoted, submitted, uploaded, proven',
      '});',
      'console.log(walrusBlobUrl(blobId));',
    ].join('\n');
  }
  return [
    "import { Connection } from '@solana/web3.js';",
    "import { TESTNET, createBosphorSolanaClientFromKeypair } from '@bosphor/sdk/solana';",
    '',
    "const connection = new Connection(TESTNET.solana.rpcUrl, 'confirmed');",
    'const client = await createBosphorSolanaClientFromKeypair({ connection, wallet: keypair });',
    '',
    'const { intentId, blobId } = await client.storePriced(bytes, {',
    `  epochs: ${epochs},`,
    '  onProgress: (e) => console.log(e.step),',
    '});',
  ].join('\n');
}
