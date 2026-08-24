import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { StagedIntentStore } from './staged-intent.store';
import { ErrorReporter } from '../observability/error-reporter';
import { REAP_INTERVAL_MS } from '../common/constants';

/**
 * Single-writer maintenance loop for the durable store queue. Runs every
 * REAP_INTERVAL_MS and does two janitorial passes the claim loop deliberately
 * leaves alone:
 *
 *   expire  -> active rows whose deadline passed before they stored become
 *              `expired` and free their bytes (the processor skips past-deadline
 *              rows; this is what actually settles them).
 *   purge   -> terminal rows (done/dead/expired) older than STAGED_RETENTION_MS
 *              are deleted so the table does not grow without bound.
 *
 * Inert without DATABASE_URL (staged is null). Non-reentrant (`reaping` guard) so
 * a slow pass never overlaps the next tick. Being single-writer, no lease or
 * re-ready machinery is needed - the expire/purge SQL is guarded by state.
 */
@Injectable()
export class StagedReaper {
  private readonly logger = new Logger(StagedReaper.name);
  private readonly retentionMs: number;
  private reaping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly errorReporter: ErrorReporter,
    // The durable queue. Null without DATABASE_URL; the reaper then stays inert.
    // Explicit @Inject because the `| null` union erases DI type metadata.
    @Optional()
    @Inject(StagedIntentStore)
    private readonly staged: StagedIntentStore | null = null,
  ) {
    this.retentionMs = this.config.get<number>('STAGED_RETENTION_MS') ?? 86_400_000;
  }

  @Interval(REAP_INTERVAL_MS)
  async reap(): Promise<void> {
    if (!this.staged || this.reaping) return;
    this.reaping = true;
    try {
      const now = Date.now();
      const expired = await this.staged.expireDue(now);
      const purged = await this.staged.purgeTerminal(now - this.retentionMs);
      if (expired > 0) {
        this.logger.warn(`Expired ${expired} past-deadline intent(s) that never stored`);
      }
      if (purged > 0) {
        this.logger.log(`Purged ${purged} terminal row(s) past retention`);
      }
    } catch (err) {
      // Loud, not silent: a reap failure is logged and reported, and the next
      // tick retries. It never blocks the store path.
      this.logger.error(`Reap failed: ${err}`);
      this.errorReporter.captureException(err);
    } finally {
      this.reaping = false;
    }
  }
}
