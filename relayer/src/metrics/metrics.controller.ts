import { Controller, Get, Res } from '@nestjs/common';
import { MetricsService } from './metrics.service';

/** Minimal structural type for the bits of the Express response we touch. */
interface ScrapeResponse {
  set(field: string, value: string): void;
}

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async scrape(@Res({ passthrough: true }) res: ScrapeResponse): Promise<string> {
    res.set('Content-Type', this.metrics.contentType);
    return this.metrics.getMetrics();
  }
}
