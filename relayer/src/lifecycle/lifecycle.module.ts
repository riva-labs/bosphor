import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { IntentLifecycleStore } from './intent-lifecycle.store';
import { InMemoryIntentLifecycleStore } from './in-memory-intent-lifecycle.store';
import { PgIntentLifecycleStore } from './pg-intent-lifecycle.store';

/**
 * Provides the single IntentLifecycleStore for the app. Uses Postgres when
 * DATABASE_URL is configured (production), otherwise an in-memory store for
 * local dev and tests. Global so any module can inject the store to record hops.
 */
@Global()
@Module({
  providers: [
    {
      provide: IntentLifecycleStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService): IntentLifecycleStore => {
        const url = config.get<string>('DATABASE_URL');
        if (url) {
          return new PgIntentLifecycleStore(new Pool({ connectionString: url }));
        }
        new Logger('LifecycleModule').warn(
          'DATABASE_URL not set — using in-memory intent store (not durable)',
        );
        return new InMemoryIntentLifecycleStore();
      },
    },
  ],
  exports: [IntentLifecycleStore],
})
export class LifecycleModule implements OnModuleInit {
  constructor(private readonly store: IntentLifecycleStore) {}

  async onModuleInit(): Promise<void> {
    if (this.store instanceof PgIntentLifecycleStore) {
      await this.store.init();
    }
  }
}
