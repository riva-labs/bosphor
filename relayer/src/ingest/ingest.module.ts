import { Module } from '@nestjs/common';
import { SuiModule } from '../chain/sui/sui.module';
import { IntentIngest } from './intent-ingest.service';
import { IngestController } from './ingest.controller';

/**
 * Out-of-band blob ingest (M3). Exposes the POST /blob/:intentId endpoint and
 * the IntentIngest service that binds received bytes to the on-chain commitment.
 * IntentLifecycleStore is provided globally by LifecycleModule.
 */
@Module({
  imports: [SuiModule],
  controllers: [IngestController],
  providers: [IntentIngest],
  exports: [IntentIngest],
})
export class IngestModule {}
