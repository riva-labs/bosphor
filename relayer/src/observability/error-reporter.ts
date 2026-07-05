import { Injectable } from '@nestjs/common';
import * as Sentry from '@sentry/node';

/** Optional context attached to a reported error. */
export interface ErrorContext {
  intentId?: string;
}

/**
 * Reports runtime errors to an external tracker. Injected so services stay
 * decoupled from Sentry and remain unit-testable. When no DSN is configured the
 * Noop implementation is used and nothing is sent.
 */
export abstract class ErrorReporter {
  abstract captureException(err: unknown, context?: ErrorContext): void;
}

@Injectable()
export class NoopErrorReporter extends ErrorReporter {
  captureException(_err: unknown, _context?: ErrorContext): void {
    // intentionally does nothing
  }
}

/** The slice of the Sentry API used here, narrowed for testability. */
export interface SentryLike {
  withScope(callback: (scope: { setTag(key: string, value: string): void }) => void): void;
  captureException(err: unknown): void;
}

@Injectable()
export class SentryErrorReporter extends ErrorReporter {
  constructor(private readonly sentry: SentryLike = Sentry) {
    super();
  }

  captureException(err: unknown, context?: ErrorContext): void {
    this.sentry.withScope((scope) => {
      if (context?.intentId) scope.setTag('intentId', context.intentId);
      this.sentry.captureException(err);
    });
  }
}
