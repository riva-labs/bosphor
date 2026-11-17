import { ethers } from 'ethers';
import {
  isRetryableJsonRpcError,
  isTransportFailure,
  parseRpcUrls,
  RPC_FAILOVER_ATTEMPT_TIMEOUT_MS,
  RpcFailover,
  RpcFailoverOptions,
} from '../../common/rpc-failover';

/** A JSON-RPC response batch that carries an endpoint-limit error (pruned logs, range cap). */
class RetryableResultError extends Error {
  constructor(
    readonly results: ethers.JsonRpcResult[],
    reason: string,
  ) {
    super(reason);
    this.name = 'RetryableResultError';
  }
}

/**
 * A JsonRpcProvider over an ordered list of endpoints (#524). Every JSON-RPC
 * request goes through `_send`, so reads, log queries, the block poller behind
 * tx.wait() and the wallet's eth_sendRawTransaction all fail over the same way.
 * A raw transaction re-sent to another endpoint is the same signed bytes (same
 * hash), so a re-send cannot double-spend; at worst the second node answers
 * "already known" / "nonce too low", which the existing nonce handling covers.
 *
 * Each endpoint gets a bounded per-attempt timeout and no internal 429 retry
 * loop, so a stalled or throttled endpoint hands over quickly.
 */
export class FailoverJsonRpcProvider extends ethers.JsonRpcProvider {
  private readonly endpoints: ethers.JsonRpcProvider[];
  readonly failover: RpcFailover;

  constructor(
    urls: string[],
    network: ethers.Networkish,
    options: ethers.JsonRpcApiProviderOptions,
    failoverOpts: RpcFailoverOptions = {},
  ) {
    super(endpointRequest(urls[0]), network, options);
    this.endpoints = urls.map(
      (url) => new ethers.JsonRpcProvider(endpointRequest(url), network, { staticNetwork: true }),
    );
    this.failover = new RpcFailover('evm', urls, {
      ...failoverOpts,
      isFailoverError: (err) => err instanceof RetryableResultError || isTransportFailure(err),
    });
  }

  override async _send(
    payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>,
  ): Promise<ethers.JsonRpcResult[]> {
    const op = Array.isArray(payload) ? payload.map((p) => p.method).join(',') : payload.method;
    try {
      return await this.failover.run(op, async (i) => {
        // Typed as results, but error responses come back in the same array.
        const results = await this.endpoints[i]._send(payload);
        for (const r of results as Array<{ error?: { message?: unknown } }>) {
          if (isRetryableJsonRpcError(r.error)) {
            throw new RetryableResultError(results, `JSON-RPC error: ${String(r.error?.message)}`);
          }
        }
        return results;
      });
    } catch (err) {
      // Every endpoint hit the same limit: hand ethers the last answer so it
      // raises its usual error for it.
      if (err instanceof RetryableResultError) return err.results;
      throw err;
    }
  }
}

function endpointRequest(url: string): ethers.FetchRequest {
  const req = new ethers.FetchRequest(url);
  req.timeout = RPC_FAILOVER_ATTEMPT_TIMEOUT_MS;
  req.setThrottleParams({ maxAttempts: 1 });
  return req;
}

/**
 * Build the relayer's EVM provider from EVM_RPC_URL. One URL yields the exact
 * JsonRpcProvider the relayer always used; a comma-separated list yields a
 * FailoverJsonRpcProvider with the first URL as primary.
 */
export function createEvmProvider(
  rpcSetting: string,
  chainId: number,
  options: ethers.JsonRpcApiProviderOptions,
  failoverOpts: RpcFailoverOptions = {},
): ethers.JsonRpcProvider {
  const urls = parseRpcUrls(rpcSetting);
  if (urls.length <= 1) return new ethers.JsonRpcProvider(urls[0] ?? rpcSetting, chainId, options);
  return new FailoverJsonRpcProvider(urls, chainId, options, failoverOpts);
}
