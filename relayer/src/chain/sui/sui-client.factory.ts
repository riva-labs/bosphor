import { GrpcWebFetchTransport, SuiGrpcClient } from '@mysten/sui/grpc';
import {
  createFailoverFetch,
  parseRpcUrls,
  RpcFailover,
  RpcFailoverOptions,
} from '../../common/rpc-failover';

/**
 * Build the relayer's Sui gRPC client from SUI_GRPC_URL (#524).
 *
 * One URL yields the exact client the relayer always used. A comma-separated
 * list routes every gRPC-web request through a failover fetch: the request is
 * re-sent byte for byte to the next endpoint on a transport failure, timeout,
 * HTTP 429/5xx or a gRPC UNAVAILABLE / RESOURCE_EXHAUSTED / DEADLINE_EXCEEDED
 * status. Execution results (a Move abort is a successful response carrying
 * failed effects) are never retried. executeTransaction sends already-signed
 * bytes, so a re-send is the same transaction (same digest) and cannot
 * double-execute. The Walrus client extends this one, so its Sui reads fail
 * over too.
 */
export function createSuiGrpcClient(
  setting: string,
  failoverOpts: RpcFailoverOptions & { baseFetch?: typeof globalThis.fetch } = {},
): SuiGrpcClient {
  const urls = parseRpcUrls(setting);
  const primary = urls[0] ?? setting;
  const network = primary.includes('mainnet') ? ('mainnet' as const) : ('testnet' as const);
  if (urls.length <= 1) return new SuiGrpcClient({ network, baseUrl: primary });

  const { baseFetch, ...opts } = failoverOpts;
  const failoverFetch = createFailoverFetch(new RpcFailover('sui', urls, opts), { baseFetch });
  const transport = new GrpcWebFetchTransport({
    baseUrl: primary,
    fetch: failoverFetch as typeof globalThis.fetch,
  });
  return new SuiGrpcClient({ network, transport });
}
