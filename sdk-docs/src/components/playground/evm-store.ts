// Browser-wallet store on Ethereum Sepolia through @bosphor/sdk/evm. Loaded with
// a dynamic import only when the reader connects a wallet. The wallet signs; no
// key ever touches this page.
import type { FetchLike, Hex, PricedQuote, StoreProgress, StoreResult } from '@bosphor/sdk';
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

/**
 * Derive the Walrus blob id through the relayer's encode-only endpoint, so the
 * browser does not need the @mysten/walrus WASM encoder. The relayer recomputes
 * the same id on upload, so a wrong id would be rejected there, not stored.
 */
function relayerComputeBlob(relayerUrl: string, toCommitmentHex: (b64: string) => Hex) {
  return async (data: Uint8Array) => {
    const res = await fetch(`${relayerUrl}/blob/encode`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'X-Bosphor-App': PLAYGROUND_APP_ID },
      body: data as BodyInit,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`relayer blob encode failed (${res.status}): ${text}`);
    const { blobId } = JSON.parse(text) as { blobId: string };
    return { blobId: toCommitmentHex(blobId), size: data.length, encodingType: 0 };
  };
}

/**
 * Upload fetch with a short retry while the relayer has not yet indexed the
 * just-mined intent (it answers 404 "no pending intent" for a few seconds).
 */
const uploadFetch: FetchLike = async (url, init) => {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const res = await fetch(url, {
      method: init.method,
      body: init.body as BodyInit,
      headers: init.headers,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (res.status !== 404 || Date.now() > deadline) return res;
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 5_000);
      init.signal?.addEventListener('abort', () => {
        clearTimeout(t);
        reject(init.signal!.reason);
      });
    });
  }
};

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
    computeBlob: relayerComputeBlob(sdk.TESTNET.relayerUrl, sdk.base64UrlToBytes32Hex),
    fetch: uploadFetch,
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

/** A short, human reason for a failed store. */
export function describeStoreError(err: unknown): string {
  const e = err as { code?: unknown; name?: string; message?: string; shortMessage?: string };
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001) return 'You rejected the request in your wallet.';
  if (e?.name === 'AbortError') {
    return 'Stopped watching. An intent that was already submitted still completes on-chain.';
  }
  if (e?.code === 'INSUFFICIENT_FUNDS') return 'Not enough Sepolia ETH for the quote plus gas.';
  if (e?.name === 'ProofTimeoutError') {
    return 'No proof yet after 10 minutes. The intent is still in flight: track it on LayerZero Scan. If it never lands, the escrow is refundable after the deadline.';
  }
  const msg = e?.shortMessage ?? e?.message ?? String(err);
  return msg.length > 260 ? `${msg.slice(0, 260)}...` : msg;
}
