import { Module } from '@nestjs/common';
import { EvmModule } from '../chain/evm/evm.module';
import { SuiModule } from '../chain/sui/sui.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [EvmModule, SuiModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
