/**
 * Classifies transient RPC / network errors from flaky public endpoints
 * (request timeouts, 5xx gateway errors, connection resets).
 *
 * The relayer already tolerates these: the EVM watcher retries on the next
 * cycle, tx.wait() polls again, and the canary/metrics track actual delivery
 * success independently. They are infra noise, not actionable bugs, so they are
 * reported to Sentry at `warning` level (grouped) instead of flooding the error
 * feed. ethers surfaces most of them as background unhandled rejections
 * (code=SERVER_ERROR / TIMEOUT), which is why they otherwise land as errors.
 */
const TRANSIENT_ETHERS_CODES = new Set(['SERVER_ERROR', 'TIMEOUT', 'NETWORK_ERROR']);

const TRANSIENT_MESSAGE_RE =
  /request timeout|server response 5\d\d|etimedout|econnreset|econnrefused|socket hang up|bad gateway|service unavailable|too many requests|error code: 5\d\d/i;

/** Follow ethers' wrapped `.cause` chain, bounded so a cycle can't loop forever. */
export function isTransientRpcError(err: unknown, depth = 0): boolean {
  if (depth > 5 || !err || typeof err !== 'object') return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_ETHERS_CODES.has(code)) return true;

  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string' && TRANSIENT_MESSAGE_RE.test(message)) return true;

  const cause = (err as { cause?: unknown }).cause;
  if (cause && cause !== err) return isTransientRpcError(cause, depth + 1);

  return false;
}
