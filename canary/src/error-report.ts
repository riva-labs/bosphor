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
}

/**
 * Initialize Sentry for the canary when a DSN is configured. Without a DSN,
 * error reporting is disabled and the canary runs unchanged.
 */
export function initSentry(dsn: string | undefined, environment: string): boolean {
  if (!dsn) return false;
  Sentry.init({ dsn, environment, tracesSampleRate: 0 });
  return true;
}

/**
 * Report a failed probe to the error tracker with intent-id and stage context.
 * A successful probe reports nothing.
 */
export function reportProbeFailure(capture: CaptureLike, res: ProbeFailureLike): void {
  if (res.success) return;
  capture.captureException(new Error(res.error ?? 'probe failed'), {
    tags: { intentId: res.intentId, stage: res.failedStage ?? 'unknown' },
  });
}
