import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { ErrorReporter, NoopErrorReporter, SentryErrorReporter } from './error-reporter';
import { isTransientRpcError } from './transient-rpc-error';

/**
 * Provides the app-wide ErrorReporter. When SENTRY_DSN is set, Sentry is
 * initialized and a SentryErrorReporter is used; otherwise a NoopErrorReporter
 * so the relayer runs unchanged without a DSN. Global so any service can inject
 * ErrorReporter to report failures with context.
 */
@Global()
@Module({
  providers: [
    {
      provide: ErrorReporter,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ErrorReporter => {
        const dsn = config.get<string>('SENTRY_DSN');
        const logger = new Logger('ObservabilityModule');
        if (!dsn) {
          logger.warn('SENTRY_DSN not set - runtime error reporting disabled');
          return new NoopErrorReporter();
        }
        Sentry.init({
          dsn,
          environment: config.get<string>('SENTRY_ENVIRONMENT') ?? 'production',
          tracesSampleRate: 0,
          // Flaky public RPCs (timeouts, 5xx) surface as background unhandled
          // rejections from ethers' poller. The relayer retries and the canary
          // tracks real delivery, so these are not actionable errors. Keep them
          // out of the error feed: downgrade to warning and collapse into one
          // grouped issue rather than a flood of distinct errors.
          beforeSend(event, hint) {
            if (isTransientRpcError(hint?.originalException)) {
              event.level = 'warning';
              event.fingerprint = ['transient-rpc-error'];
            }
            return event;
          },
        });
        logger.log('Sentry error reporting enabled');
        return new SentryErrorReporter();
      },
    },
  ],
  exports: [ErrorReporter],
})
export class ObservabilityModule {}
