import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { EvmModule } from './chain/evm/evm.module';
import { SuiModule } from './chain/sui/sui.module';
import { WalrusModule } from './walrus/walrus.module';
import { IntentModule } from './intent/intent.module';
import { HealthModule } from './health/health.module';
import { MetricsModule } from './metrics/metrics.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { WaitlistModule } from './waitlist/waitlist.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({
  imports: [
    AppConfigModule,
    ScheduleModule.forRoot(),
    ObservabilityModule,
    MetricsModule,
    LifecycleModule,
    WaitlistModule,
    EvmModule,
    SuiModule,
    WalrusModule,
    IntentModule,
    HealthModule,
  ],
})
export class AppModule {}
