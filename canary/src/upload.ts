import { RelayerUploadError } from '@bosphor/sdk/evm';

export interface UploadRetryOpts {
  /** Poll interval between attempts. Defaults to 3s. */
  intervalMs?: number;
  /** Give up after this long. Defaults to 90s. */
  timeoutMs?: number;
}

/**
 * Upload the blob to the relayer, retrying while it has not yet registered the
 * intent (HTTP 404 "no pending intent"). The relayer only accepts bytes once its
 * EVM/Solana watcher has seen the on-chain IntentSubmitted (a poll-interval lag),
 * so a single POST right after submit races that window. Every other rejection
 * (already-executed, expired, size/blob mismatch) is terminal and rethrown at
 * once, so a genuinely bad blob still fails fast.
 */
export async function uploadWithRetry(
  upload: (intentId: string, data: Uint8Array) => Promise<void>,
  intentId: string,
  data: Uint8Array,
  opts: UploadRetryOpts = {},
): Promise<void> {
  const intervalMs = opts.intervalMs ?? 3_000;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  for (;;) {
    try {
      await upload(intentId, data);
      return;
    } catch (err) {
      const status = err instanceof RelayerUploadError ? err.status : undefined;
      if (status === 404 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      throw err;
    }
  }
}
