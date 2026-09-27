// Human reasons for a failed store, shared by the EVM and Solana wallet flows.
// Imported lazily with the chain modules, so it can import the SDK statically.
import { RelayerRequestError, RelayerUploadError } from '@bosphor/sdk';
import type { Chain } from './format';

/** A short, human reason for a failed store. */
export function describeStoreError(err: unknown, chain: Chain): string {
  const e = err as { code?: unknown; name?: string; message?: string; shortMessage?: string; retryAfterMs?: number };
  const msg = e?.shortMessage ?? e?.message ?? String(err);
  if (e?.code === 'ACTION_REJECTED' || e?.code === 4001 || /user rejected/i.test(msg)) {
    return 'You rejected the request in your wallet.';
  }
  if (e?.name === 'AbortError') {
    return 'Stopped watching. An intent that was already submitted still completes on-chain.';
  }
  if (e?.code === 'INSUFFICIENT_FUNDS' || /insufficient (funds|lamports)|no record of a prior credit/i.test(msg)) {
    return chain === 'evm'
      ? 'Not enough Sepolia ETH for the quote plus gas.'
      : 'Not enough devnet SOL for the quote plus fees and account rent.';
  }
  if (e?.name === 'ProofTimeoutError') {
    return 'No proof yet after 10 minutes. The intent is still in flight: track it on LayerZero Scan. If it never lands, the escrow is refundable after the deadline.';
  }
  // Relayer errors carry the Retry-After the relayer asked for (429 or 503).
  if ((err instanceof RelayerRequestError || err instanceof RelayerUploadError) && e.retryAfterMs) {
    return `The testnet relayer is busy. Try again in ${Math.ceil(e.retryAfterMs / 1000)}s.`;
  }
  return msg.length > 260 ? `${msg.slice(0, 260)}...` : msg;
}
