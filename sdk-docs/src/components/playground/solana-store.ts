// Browser-wallet store on Solana devnet through @bosphor/sdk/solana. Loaded with
// a dynamic import only when the reader connects a wallet. Phantom signs; no key
// ever touches this page.
import type { PricedQuote, StoreProgress, StoreResult } from '@bosphor/sdk';
import { PLAYGROUND_APP_ID } from './format';

/**
 * The injected Solana provider surface we use (Phantom, and wallets that mimic
 * it on `window.solana`). The SDK needs only `publicKey` and `signTransaction`.
 */
export interface InjectedSolana {
  isPhantom?: boolean;
  publicKey: { toBase58(): string } | null;
  connect(): Promise<{ publicKey: { toBase58(): string } }>;
  disconnect?(): Promise<void>;
  signTransaction(transaction: never): Promise<unknown>;
  on?(event: string, handler: (...args: never[]) => void): void;
  off?(event: string, handler: (...args: never[]) => void): void;
  removeListener?(event: string, handler: (...args: never[]) => void): void;
}

export function injectedSolana(): InjectedSolana | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { phantom?: { solana?: InjectedSolana }; solana?: InjectedSolana };
  const p = w.phantom?.solana ?? w.solana ?? null;
  return p && typeof p.connect === 'function' && typeof p.signTransaction === 'function' ? p : null;
}

// One devnet connection per page session.
let connection: Promise<unknown> | undefined;

async function getConnection() {
  connection ??= (async () => {
    const [{ Connection }, { TESTNET }] = await Promise.all([import('@solana/web3.js'), import('@bosphor/sdk')]);
    return new Connection(TESTNET.solana.rpcUrl, 'confirmed');
  })();
  return connection;
}

/** Ask the wallet to connect and return the base58 address. */
export async function connectSolana(wallet: InjectedSolana): Promise<string> {
  const { publicKey } = await wallet.connect();
  return publicKey.toBase58();
}

/** Devnet balance in lamports. */
export async function readSolanaBalance(address: string): Promise<bigint> {
  const [{ PublicKey }, conn] = await Promise.all([import('@solana/web3.js'), getConnection()]);
  const lamports = await (conn as { getBalance(k: unknown): Promise<number> }).getBalance(new PublicKey(address));
  return BigInt(lamports);
}

export type SolanaStoreRunResult = StoreResult & { quote: PricedQuote };

/** Run the one-call paid store from the connected Solana wallet, reporting each step. */
export async function runSolanaStore(opts: {
  wallet: InjectedSolana;
  data: Uint8Array;
  epochs: number;
  signal: AbortSignal;
  onProgress: (e: StoreProgress) => void;
}): Promise<SolanaStoreRunResult> {
  const [web3, sdk, conn] = await Promise.all([
    import('@solana/web3.js'),
    import('@bosphor/sdk/solana'),
    getConnection(),
  ]);
  const client = await sdk.createBosphorSolanaClientFromWallet({
    connection: conn as object,
    wallet: opts.wallet,
    // Injected so the bundler resolves @solana/web3.js statically.
    web3,
    // Blob id from the relayer's POST /blob/encode: no Walrus WASM in the page.
    computeBlob: 'relayer',
    appId: PLAYGROUND_APP_ID,
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
