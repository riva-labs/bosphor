import { Module } from '@nestjs/common';
import { EvmModule } from '../chain/evm/evm.module';
import { SuiModule } from '../chain/sui/sui.module';
import { SolanaModule } from '../chain/solana/solana.module';
import { WalrusModule } from '../walrus/walrus.module';
import { IngestModule } from '../ingest/ingest.module';
import { SettlementModule } from '../settlement/settlement.module';
import { IntentProcessor } from './intent.processor';

@Module({
  imports: [EvmModule, SuiModule, SolanaModule, WalrusModule, IngestModule, SettlementModule],
  providers: [IntentProcessor],
  exports: [IntentProcessor],
})
export class IntentModule {}
