import {
  Controller,
  Get,
  Logger,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { IntentLifecycleStore } from './intent-lifecycle.store';
import { IntentLifecycleRecord } from './intent-lifecycle.types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

interface IntentFeedResponse {
  intents: IntentLifecycleRecord[];
  count: number;
}

/**
 * Read-only public API backing status.bosphor.xyz. Serves real data only: if
 * the store is unavailable it returns an explicit 503 rather than a fabricated
 * feed. CORS is restricted to the dashboard origin in main.ts.
 */
@Controller('public')
export class PublicController {
  private readonly logger = new Logger(PublicController.name);

  constructor(private readonly store: IntentLifecycleStore) {}

  @Get('intents')
  async getIntents(@Query('limit') limit?: string): Promise<IntentFeedResponse> {
    const parsed = Number.parseInt(limit ?? '', 10);
    const effectiveLimit = Number.isFinite(parsed)
      ? Math.min(Math.max(parsed, 1), MAX_LIMIT)
      : DEFAULT_LIMIT;

    try {
      const intents = await this.store.getRecentIntents(effectiveLimit);
      return { intents, count: intents.length };
    } catch (err) {
      this.logger.error(`Failed to serve intent feed: ${err}`);
      throw new ServiceUnavailableException('intent feed temporarily unavailable');
    }
  }
}
