import { Module } from '@nestjs/common';
import { SuiModule } from '../chain/sui/sui.module';
import { WalrusService } from './walrus.service';
import { WalTopUpService } from './wal-topup.service';

@Module({
  imports: [SuiModule],
  providers: [WalrusService, WalTopUpService],
  exports: [WalrusService, WalTopUpService],
})
export class WalrusModule {}
