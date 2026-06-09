import { Module } from '@nestjs/common';
import { SuiService } from './sui.service';
import { SuiCheckpointService } from './sui-checkpoint.service';

@Module({
  providers: [SuiService, SuiCheckpointService],
  exports: [SuiService, SuiCheckpointService],
})
export class SuiModule {}
