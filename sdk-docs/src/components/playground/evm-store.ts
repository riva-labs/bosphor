// Browser-wallet store on Ethereum Sepolia through @bosphor/sdk/evm. Loaded with
// a dynamic import only when the reader connects a wallet. The wallet signs; no
// key ever touches this page.
import type { PricedQuote, StoreProgress, StoreResult } from '@bosphor/sdk';
import { PLAYGROUND_APP_ID } from './format';

export const SEPOLIA_CHAIN_ID = 11155111;
const SEPOLIA_HEX = `0x${SEPOLIA_CHAIN_ID.toString(16)}`;

/** Minimal EIP-1193 provider surface (MetaMask, Rabby, Coinbase Wallet, ...). */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export function injectedWallet(): Eip1193 | null {
  if (typeof window === 'undefined') return null;
  return ((window as unknown as { ethereum?: Eip1193 }).ethereum ?? null) as Eip1193 | null;
}

export async function requestAccount(wallet: Eip1193): Promise<string> {
  const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[];
  if (!accounts?.[0]) throw new Error('The wallet returned no account.');
  return accounts[0];
}

export async function readChainId(wallet: Eip1193): Promise<number> {
  return Number.parseInt((await wallet.request({ method: 'eth_chainId' })) as string, 16);
}

/** Ask the wallet to switch to Sepolia, adding the chain first if it is unknown. */
export async function switchToSepolia(wallet: Eip1193): Promise<void> {
  try {
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: SEPOLIA_HEX }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    const { TESTNET } = await import('@bosphor/sdk');
    await wallet.request({
      method: 'wallet_addEthereumChain',
      params: [
        {
          chainId: SEPOLIA_HEX,
          chainName: TESTNET.evm.chainName,
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
          rpcUrls: [TESTNET.evm.rpcUrl],
          blockExplorerUrls: [TESTNET.evm.explorerUrl],
        },
      ],
    });
  }
}

export async function readBalance(wallet: Eip1193, address: string): Promise<bigint> {
  return BigInt((await wallet.request({ method: 'eth_getBalance', params: [address, 'latest'] })) as string);
}

export type StoreRunResult = StoreResult & { quote: PricedQuote };

/** Run the one-call paid store from the injected wallet, reporting each step. */
export async function runEvmStore(opts: {
  wallet: Eip1193;
  data: Uint8Array;
  epochs: number;
  signal: AbortSignal;
  onProgress: (e: StoreProgress) => void;
}): Promise<StoreRunResult> {
  const [ethers, sdk] = await Promise.all([import('ethers'), import('@bosphor/sdk/evm')]);
  const provider = new ethers.BrowserProvider(opts.wallet as never);
  const signer = await provider.getSigner();
  const client = await sdk.createBosphorClientFromSigner(signer, {
    appId: PLAYGROUND_APP_ID,
    ethers,
    // Blob id from the relayer's POST /blob/encode: no Walrus WASM in the page.
    // The upload retries on its own while the relayer indexes the new intent.
    computeBlob: 'relayer',
  });
  return client.storePriced(opts.data, {
    epochs: opts.epochs,
    onProgress: opts.onProgress,
    signal: opts.signal,
    // An LZ round trip plus the Walrus store usually takes 1 to 3 minutes.
    timeoutMs: 10 * 60_000,
    pollMs: 5_000,
  });
}
