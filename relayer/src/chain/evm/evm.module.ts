import { Module } from '@nestjs/common';
import { EvmService } from './evm.service';

@Module({
  providers: [EvmService],
  exports: [EvmService],
})
export class EvmModule {}
