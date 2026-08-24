import { Global, Inject, Logger, Module, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { StagedIntentStore } from './staged-intent.store';
import { StagedReaper } from './staged-reaper.service';

/**
 * Provides the durable store queue (`staged_intent`). Uses Postgres when
 * DATABASE_URL is configured (the only durable mode); without it the queue is
 * disabled (the provider resolves to null) so local dev / tests that do not set
 * DATABASE_URL still boot. The table is created idempotently on init. Global so
 * the ingest + processor modules can inject the store. Also hosts the reaper,
 * the single-writer maintenance loop that expires past-deadline rows and purges
 * terminal rows past retention.
 */
@Global()
@Module({
  providers: [
    {
      provide: StagedIntentStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StagedIntentStore | null => {
        const url = config.get<string>('DATABASE_URL');
        if (url) {
          return new StagedIntentStore(new Pool({ connectionString: url }));
        }
        new Logger('StagedModule').warn(
          'DATABASE_URL not set - durable store queue disabled (in-memory dev only)',
        );
        return null;
      },
    },
    StagedReaper,
  ],
  exports: [StagedIntentStore],
})
export class StagedModule implements OnModuleInit {
  // Explicit @Inject token: the `| null` union erases DI type metadata, so
  // without it Nest cannot resolve the provider and @Optional silently injects
  // null, which skips init() and leaves the staged_intent table uncreated. This
  // only surfaces when DATABASE_URL is set (the store is non-null). Matches the
  // same guard in IntentProcessor and IntentIngest.
  constructor(
    @Optional() @Inject(StagedIntentStore) private readonly store: StagedIntentStore | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.store) {
      await this.store.init();
    }
  }
}
