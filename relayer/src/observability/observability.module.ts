import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/node';
import { ErrorReporter, NoopErrorReporter, SentryErrorReporter } from './error-reporter';

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
          logger.warn('SENTRY_DSN not set — runtime error reporting disabled');
          return new NoopErrorReporter();
        }
        Sentry.init({
          dsn,
          environment: config.get<string>('SENTRY_ENVIRONMENT') ?? 'production',
          tracesSampleRate: 0,
        });
        logger.log('Sentry error reporting enabled');
        return new SentryErrorReporter();
      },
    },
  ],
  exports: [ErrorReporter],
})
export class ObservabilityModule {}
