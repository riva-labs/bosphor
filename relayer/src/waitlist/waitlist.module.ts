import { Global, Logger, Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { InMemoryWaitlistStore } from './in-memory-waitlist.store';
import { PgWaitlistStore } from './pg-waitlist.store';
import { WaitlistController } from './waitlist.controller';
import { WaitlistStore } from './waitlist.store';

/**
 * Provides the single WaitlistStore for the app. Uses Postgres when DATABASE_URL
 * is configured (production), otherwise an in-memory store for local dev and
 * tests. Mirrors LifecycleModule so the two public stores wire identically.
 */
@Global()
@Module({
  controllers: [WaitlistController],
  providers: [
    {
      provide: WaitlistStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService): WaitlistStore => {
        const url = config.get<string>('DATABASE_URL');
        if (url) {
          return new PgWaitlistStore(new Pool({ connectionString: url }));
        }
        new Logger('WaitlistModule').warn(
          'DATABASE_URL not set — using in-memory waitlist store (not durable)',
        );
        return new InMemoryWaitlistStore();
      },
    },
  ],
  exports: [WaitlistStore],
})
export class WaitlistModule implements OnModuleInit {
  constructor(private readonly store: WaitlistStore) {}

  async onModuleInit(): Promise<void> {
    if (this.store instanceof PgWaitlistStore) {
      await this.store.init();
    }
  }
}
