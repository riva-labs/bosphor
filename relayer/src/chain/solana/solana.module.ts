import { Module } from '@nestjs/common';
import { SuiModule } from '../sui/sui.module';
import { SolanaService } from './solana.service';
import { SolanaLifecycleWatcher } from './solana-lifecycle.watcher';

/**
 * Solana-origin support. The watcher records the `submitted` commitment for
 * intents that originate on the Solana adapter, so the ingest and execute_store
 * paths work uniformly with the EVM origin. Inert unless SOLANA_RPC_URL and
 * SOLANA_PROGRAM_ID are configured. Imports SuiModule for the fallback recipient
 * address.
 */
@Module({
  imports: [SuiModule],
  providers: [SolanaService, SolanaLifecycleWatcher],
  exports: [SolanaService],
})
export class SolanaModule {}
