import { Injectable, Logger } from '@nestjs/common';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';

export interface HealthStatus {
  status: string;
  evm: {
    connected: boolean;
    blockNumber?: number;
  };
  sui: {
    connected: boolean;
    checkpoint?: string;
  };
  uptime: number;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly startTime = Date.now();

  constructor(
    private readonly evm: EvmService,
    private readonly sui: SuiService,
  ) {}

  async getHealth(): Promise<HealthStatus> {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    let evmConnected = false;
    let blockNumber: number | undefined;
    try {
      blockNumber = await this.evm.getBlockNumber();
      evmConnected = true;
    } catch (err) {
      this.logger.warn(`EVM health check failed: ${err}`);
    }

    let suiConnected = false;
    let checkpoint: string | undefined;
    try {
      checkpoint = await this.sui.getCheckpoint();
      suiConnected = true;
    } catch (err) {
      this.logger.warn(`Sui health check failed: ${err}`);
    }

    return {
      status: evmConnected && suiConnected ? 'ok' : 'degraded',
      evm: { connected: evmConnected, blockNumber },
      sui: { connected: suiConnected, checkpoint },
      uptime,
    };
  }
}
