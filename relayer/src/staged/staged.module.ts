import { Global, Logger, Module, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { StagedIntentStore } from './staged-intent.store';

/**
 * Provides the durable store queue (`staged_intent`). Uses Postgres when
 * DATABASE_URL is configured (the only durable mode); without it the queue is
 * disabled (the provider resolves to null) so local dev / tests that do not set
 * DATABASE_URL still boot. The table is created idempotently on init. Global so
 * the ingest + processor modules can inject the store. No consumer wires it yet
 * (this slice only lands the table + store); later slices drive it.
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
  ],
  exports: [StagedIntentStore],
})
export class StagedModule implements OnModuleInit {
  constructor(@Optional() private readonly store: StagedIntentStore | null) {}

  async onModuleInit(): Promise<void> {
    if (this.store) {
      await this.store.init();
    }
  }
}
