import { Commitment, Connection, FetchFn } from '@solana/web3.js';
import {
  createFailoverFetch,
  parseRpcUrls,
  RpcFailover,
  RpcFailoverOptions,
} from '../../common/rpc-failover';

/**
 * Build a Solana Connection from SOLANA_RPC_URL (#524).
 *
 * One URL yields the exact Connection the relayer always used. A
 * comma-separated list keeps the first URL as the Connection endpoint (so the
 * websocket used for confirmations derives from the primary) and routes every
 * HTTP JSON-RPC request through a failover fetch: re-sent to the next endpoint
 * on transport errors, timeouts, HTTP 429/5xx or an endpoint-limit JSON-RPC
 * error (node unhealthy, rate limited). Request errors such as a failed
 * preflight simulation are returned as-is. sendTransaction carries the signed
 * transaction bytes, so a re-send is the same signature and cannot
 * double-spend.
 */
export function createSolanaConnection(
  setting: string,
  commitment: Commitment,
  failoverOpts: RpcFailoverOptions & { baseFetch?: typeof globalThis.fetch } = {},
): Connection {
  const urls = parseRpcUrls(setting);
  const primary = urls[0] ?? setting;
  if (urls.length <= 1) return new Connection(primary, commitment);

  const { baseFetch, ...opts } = failoverOpts;
  const failoverFetch = createFailoverFetch(new RpcFailover('solana', urls, opts), { baseFetch });
  return new Connection(primary, {
    commitment,
    fetch: ((input: string, init?: RequestInit) =>
      failoverFetch(String(input), init)) as unknown as FetchFn,
  });
}
