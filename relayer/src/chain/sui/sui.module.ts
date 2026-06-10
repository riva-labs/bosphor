import { Module } from '@nestjs/common';
import { SuiService } from './sui.service';
import { SuiCheckpointService } from './sui-checkpoint.service';
import { SuiLzService } from './sui-lz.service';

@Module({
  providers: [SuiService, SuiCheckpointService, SuiLzService],
  exports: [SuiService, SuiCheckpointService, SuiLzService],
})
export class SuiModule {}
