import { Module } from '@nestjs/common';
import { EvmService } from './evm.service';
import { EvmLifecycleWatcher } from './evm-lifecycle.watcher';

@Module({
  providers: [EvmService, EvmLifecycleWatcher],
  exports: [EvmService],
})
export class EvmModule {}
