// Wallet-free quoting against the hosted testnet. Every chain library is pulled
// in with a dynamic import on the first quote, so docs pages that never run one
// never download ethers.
import type { PricedQuote } from '@bosphor/sdk';
import { PLAYGROUND_APP_ID, type Chain } from './format';

// Cached read-only EVM provider: one per page session.
let evmProvider: Promise<unknown> | undefined;

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

export interface QuoteArgs {
  chain: Chain;
  sizeBytes: number;
  epochs: number;
  signal: AbortSignal;
}

/** Fetch a live priced quote from the hosted testnet through the SDK helpers. */
export async function fetchPlaygroundQuote({ chain, sizeBytes, epochs, signal }: QuoteArgs): Promise<PricedQuote> {
  if (chain === 'evm') {
    const [sdk, ethers, provider] = await Promise.all([
      import('@bosphor/sdk/evm'),
      import('ethers'),
      getEvmProvider(),
    ]);
    return sdk.quoteEvmStore({
      provider: provider as never,
      sizeBytes,
      epochs,
      appId: PLAYGROUND_APP_ID,
      signal,
      // Injected so the bundler resolves ethers statically.
      ethers,
    });
  }
  // No connection and no LayerZero SDK needed: the relayer simulates the live
  // LayerZero fee (GET /lz-fee/solana), so the quote is exact.
  const sdk = await import('@bosphor/sdk/solana');
  return sdk.quoteSolanaStore({ sizeBytes, epochs, appId: PLAYGROUND_APP_ID, signal });
}

/** Milliseconds the relayer asked us to wait (Retry-After on a 429 or 503), if any. */
export function retryAfterMsOf(err: unknown): number | undefined {
  const ms = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof ms === 'number' && ms > 0 ? ms : undefined;
}

/** A short, human reason for a failed quote. */
export async function describeQuoteError(err: unknown): Promise<string> {
  const { RelayerRequestError } = await import('@bosphor/sdk');
  if (err instanceof RelayerRequestError) {
    if (err.status === 429) return 'The testnet relayer is rate limiting quotes.';
    if (err.status === 503) return 'The testnet relayer is busy right now.';
    return `The testnet relayer could not price this store (HTTP ${err.status}). Try again in a moment.`;
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (/failed to fetch|networkerror|load failed|fetch failed/i.test(msg)) {
    return 'Could not reach the testnet relayer or RPC. Check your connection and try again.';
  }
  if (/missing response|timeout|could not coalesce|server_error|bad_data/i.test(msg)) {
    return 'The public testnet RPC did not answer in time. Try again in a moment.';
  }
  return msg.length > 220 ? `${msg.slice(0, 220)}...` : msg;
}
