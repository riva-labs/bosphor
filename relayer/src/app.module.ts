import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AppConfigModule } from './config/config.module';
import { EvmModule } from './chain/evm/evm.module';
import { SuiModule } from './chain/sui/sui.module';
import { WalrusModule } from './walrus/walrus.module';
import { IntentModule } from './intent/intent.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    AppConfigModule,
    ScheduleModule.forRoot(),
    EvmModule,
    SuiModule,
    WalrusModule,
    IntentModule,
    HealthModule,
  ],
})
export class AppModule {}
