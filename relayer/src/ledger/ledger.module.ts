import { Global, Inject, Logger, Module, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { StorageOpLedgerStore } from './storage-op-ledger.store';
import { StorageOpLedger } from './storage-op-ledger.service';

/**
 * Provides the durable ops ledger (`storage_op_ledger`) and its writer. Uses
 * Postgres when DATABASE_URL is configured; without it the store resolves to
 * null and the writer is inert (local dev / tests). The table is created
 * idempotently on init. Global so the intent processor can inject the writer.
 */
@Global()
@Module({
  providers: [
    {
      provide: StorageOpLedgerStore,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageOpLedgerStore | null => {
        const url = config.get<string>('DATABASE_URL');
        if (url) {
          return new StorageOpLedgerStore(
            new Pool({
              connectionString: url,
              // The ledger does one small write per completed store plus a
              // periodic backfill; it needs only a couple of connections.
              max: 4,
              connectionTimeoutMillis: 10_000,
              idleTimeoutMillis: 30_000,
            }),
          );
        }
        new Logger('LedgerModule').warn('DATABASE_URL not set - durable ops ledger disabled');
        return null;
      },
    },
    StorageOpLedger,
  ],
  exports: [StorageOpLedgerStore, StorageOpLedger],
})
export class LedgerModule implements OnModuleInit {
  // Explicit @Inject token: the `| null` union erases DI type metadata (same
  // guard as StagedModule).
  constructor(
    @Optional()
    @Inject(StorageOpLedgerStore)
    private readonly store: StorageOpLedgerStore | null = null,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.store) await this.store.init();
  }
}
