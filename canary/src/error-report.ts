import * as Sentry from '@sentry/node';

/** The slice of the Sentry API used here, narrowed for testability. */
export interface CaptureLike {
  captureException(err: unknown, context?: { tags?: Record<string, string> }): void;
}

/** A failed probe result, structurally. */
export interface ProbeFailureLike {
  success: boolean;
  intentId: string;
  failedStage?: string;
  error?: string;
  /** Origin chain the probe ran against, surfaced as a Sentry tag. */
  chain?: string;
}

// Flaky public RPC noise (rate limits, timeouts, 5xx). The probe interval
// retries naturally and Prometheus failure-rate alerts catch a persistent
// outage, so a single rate-limited submit is not an actionable error. Mirror
// the relayer: downgrade to warning and collapse into one grouped issue.
// Kept in sync with the relayer's transient-rpc-error patterns. Probe errors
// arrive as strings here, so ethers codes are matched in their stringified
// form (code=SERVER_ERROR) rather than via the error object.
const TRANSIENT_RPC_RE =
  /429|too many requests|rate limit|etimedout|econnreset|econnrefused|request timeout|fetch failed|socket hang up|bad gateway|service unavailable|server response 5\d\d|error code: 5\d\d|code=(SERVER_ERROR|NETWORK_ERROR|TIMEOUT)/i;

export function isTransientRpcError(err: unknown): boolean {
  return TRANSIENT_RPC_RE.test(err instanceof Error ? err.message : String(err));
}

/**
 * Initialize Sentry for the canary when a DSN is configured. Without a DSN,
 * error reporting is disabled and the canary runs unchanged.
 */
export function initSentry(dsn: string | undefined, environment: string): boolean {
  if (!dsn) return false;
  Sentry.init({
    dsn,
    environment,
    tracesSampleRate: 0,
    beforeSend(event, hint) {
      if (isTransientRpcError(hint?.originalException)) {
        event.level = 'warning';
        event.fingerprint = ['transient-rpc-error'];
      }
      return event;
    },
  });
  return true;
}

/**
 * Report a failed probe to the error tracker with intent-id and stage context.
 * A successful probe reports nothing. Empty tags are omitted: a probe that
 * fails at submit has no intent id yet, and Sentry rejects empty tag values.
 */
export function reportProbeFailure(capture: CaptureLike, res: ProbeFailureLike): void {
  if (res.success) return;
  const tags: Record<string, string> = {
    stage: res.failedStage ?? 'unknown',
    chain: res.chain ?? 'unknown',
  };
  if (res.intentId) tags.intentId = res.intentId;
  capture.captureException(new Error(res.error ?? 'probe failed'), { tags });
}
