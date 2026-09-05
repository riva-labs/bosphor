import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { EvmModule } from './chain/evm/evm.module';
import { SuiModule } from './chain/sui/sui.module';
import { SolanaModule } from './chain/solana/solana.module';
import { WalrusModule } from './walrus/walrus.module';
import { PricingModule } from './pricing/pricing.module';
import { SettlementModule } from './settlement/settlement.module';
import { IntentModule } from './intent/intent.module';
import { IngestModule } from './ingest/ingest.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { StagedModule } from './staged/staged.module';
import { ObservabilityModule } from './observability/observability.module';
import { WakerModule } from './common/waker.module';

@Module({
  imports: [
    AppConfigModule,
    ScheduleModule.forRoot(),
    WakerModule,
    ObservabilityModule,
    MetricsModule,
    LifecycleModule,
    StagedModule,
    EvmModule,
    SuiModule,
    SolanaModule,
    WalrusModule,
    PricingModule,
    SettlementModule,
    IngestModule,
    IntentModule,
    HealthModule,
  ],
})
export class AppModule {}
