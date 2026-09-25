// Wallet-free quoting against the hosted testnet. Every chain library is pulled
// in with a dynamic import on the first quote, so docs pages that never run one
// never download ethers or @solana/web3.js.
import type { FetchLike, PricedQuote } from '@bosphor/sdk';
import { PLAYGROUND_APP_ID, type Chain } from './format';

/** The relayer answered 429: wait `retryAfterSeconds` before the next quote. */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`The testnet relayer is rate limiting quotes. Try again in ${retryAfterSeconds}s.`);
    this.name = 'RateLimitedError';
  }
}

/**
 * A `fetch` for the SDK that remembers the Retry-After of a 429 (the SDK error
 * carries only the status and body) so the UI can show a countdown.
 */
export function trackingFetch(): { fetch: FetchLike; retryAfter: () => number | null } {
  let retryAfter: number | null = null;
  const fetchFn: FetchLike = async (url, init) => {
    const res = await fetch(url, {
      method: init.method,
      body: init.body as BodyInit,
      headers: init.headers,
      ...(init.signal ? { signal: init.signal } : {}),
    });
    if (res.status === 429) {
      const header = Number(res.headers.get('retry-after'));
      retryAfter = Number.isFinite(header) && header > 0 ? header : 30;
    }
    return res;
  };
  return { fetch: fetchFn, retryAfter: () => retryAfter };
}

// Cached read-only chain handles: one provider / connection per page session.
let evmProvider: Promise<unknown> | undefined;
let solanaConnection: Promise<unknown> | undefined;

async function getEvmProvider() {
  evmProvider ??= (async () => {
    const [{ JsonRpcProvider, Network }, { TESTNET }] = await Promise.all([
      import('ethers'),
      import('@bosphor/sdk'),
    ]);
    // A static network skips the eth_chainId probe on every call.
    const network = Network.from(TESTNET.evm.chainId);
    return new JsonRpcProvider(TESTNET.evm.rpcUrl, network, { staticNetwork: network });
  })();
  return evmProvider;
}

async function getSolanaConnection() {
  solanaConnection ??= (async () => {
    const [{ Connection }, { TESTNET }] = await Promise.all([
      import('@solana/web3.js'),
      import('@bosphor/sdk'),
    ]);
    return new Connection(TESTNET.solana.rpcUrl, 'confirmed');
  })();
  return solanaConnection;
}

export interface QuoteArgs {
  chain: Chain;
  sizeBytes: number;
  epochs: number;
  signal: AbortSignal;
}

/** Fetch a live priced quote from the hosted testnet through the SDK helpers. */
export async function fetchPlaygroundQuote({ chain, sizeBytes, epochs, signal }: QuoteArgs): Promise<PricedQuote> {
  const tracker = trackingFetch();
  try {
    if (chain === 'evm') {
      const [sdk, ethers, provider] = await Promise.all([
        import('@bosphor/sdk/evm'),
        import('ethers'),
        getEvmProvider(),
      ]);
      return await sdk.quoteEvmStore({
        provider: provider as never,
        sizeBytes,
        epochs,
        appId: PLAYGROUND_APP_ID,
        fetch: tracker.fetch,
        signal,
        // Injected so the bundler resolves ethers statically (the SDK's own lazy
        // import uses a runtime specifier a browser bundle cannot resolve).
        ethers,
      });
    }
    const [sdk, web3, connection] = await Promise.all([
      import('@bosphor/sdk/solana'),
      import('@solana/web3.js'),
      getSolanaConnection(),
    ]);
    // Without the optional @layerzerolabs/lz-solana-sdk-v2 peer (too heavy for a
    // docs page), the SDK prices the LayerZero leg at the preset fee cap and flags
    // the quote with forwardIsUpperBound.
    return await sdk.quoteSolanaStore({
      connection: connection as object,
      sizeBytes,
      epochs,
      appId: PLAYGROUND_APP_ID,
      fetch: tracker.fetch,
      signal,
      web3,
    });
  } catch (err) {
    const wait = tracker.retryAfter();
    if (wait !== null) throw new RateLimitedError(wait);
    throw err;
  }
}

/** A short, human reason for a failed quote. */
export function describeQuoteError(err: unknown): string {
  if (err instanceof RateLimitedError) return err.message;
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return 'Could not reach the testnet relayer or RPC. Check your connection and try again.';
  }
  if (/relayer quote failed \((\d+)\)/.test(msg)) {
    const status = msg.match(/\((\d+)\)/)?.[1];
    return `The testnet relayer could not price this store (HTTP ${status}). Try again in a moment.`;
  }
  if (/missing response|timeout|could not coalesce|server_error|bad_data/i.test(msg)) {
    return 'The public testnet RPC did not answer in time. Try again in a moment.';
  }
  return msg.length > 220 ? `${msg.slice(0, 220)}...` : msg;
}
