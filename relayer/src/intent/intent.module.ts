import { Module } from '@nestjs/common';
import { EvmModule } from '../chain/evm/evm.module';
import { SuiModule } from '../chain/sui/sui.module';
import { WalrusModule } from '../walrus/walrus.module';
import { IngestModule } from '../ingest/ingest.module';
import { IntentProcessor } from './intent.processor';

@Module({
  imports: [EvmModule, SuiModule, WalrusModule, IngestModule],
  providers: [IntentProcessor],
  exports: [IntentProcessor],
})
export class IntentModule {}
