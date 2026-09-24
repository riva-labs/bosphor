import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/**
 * Provides the Prometheus registry. There is deliberately no HTTP controller
 * here: /metrics exposes wallet balances and internal queue state, so it is
 * served on a separate internal port (METRICS_PORT, see metrics-server.ts and
 * main.ts) instead of the public API port.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
