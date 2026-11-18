import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { StagedIntentStore } from './staged-intent.store';
import { ErrorReporter } from '../observability/error-reporter';
import { MetricsService } from '../metrics/metrics.service';
import { REAP_INTERVAL_MS } from '../common/constants';

/**
 * Single-writer maintenance loop for the durable store queue. Runs every
 * REAP_INTERVAL_MS and does two janitorial passes the claim loop deliberately
 * leaves alone:
 *
 *   expire  -> active rows whose deadline passed before they stored become
 *              `expired` and free their bytes (the processor skips past-deadline
 *              rows; this is what actually settles them).
 *   orphan  -> active rows that buffered bytes but were never received from Sui
 *              (forward delivery lost or skipped, so no deadline ever arrives)
 *              become `expired` after STAGED_UNRECEIVED_TTL_MS and free their
 *              bytes. Logged by id and counted (staged_orphan_expired_total),
 *              so a real forward outage stays visible.
 *   purge   -> terminal rows (done/dead/expired) older than STAGED_RETENTION_MS
 *              are deleted so the table does not grow without bound.
 *   gauges  -> publish the queue depth (active / bytes / dead) so the dashboard
 *              and alerts see backpressure headroom and dead-letter buildup.
 *
 * Inert without DATABASE_URL (staged is null). Non-reentrant (`reaping` guard) so
 * a slow pass never overlaps the next tick. Being single-writer, no lease or
 * re-ready machinery is needed - the expire/purge SQL is guarded by state.
 */
@Injectable()
export class StagedReaper {
  private readonly logger = new Logger(StagedReaper.name);
  private readonly retentionMs: number;
  private readonly unreceivedTtlMs: number;
  private reaping = false;

  constructor(
    private readonly config: ConfigService,
    private readonly errorReporter: ErrorReporter,
    private readonly metrics: MetricsService,
    // The durable queue. Null without DATABASE_URL; the reaper then stays inert.
    // Explicit @Inject because the `| null` union erases DI type metadata.
    @Optional()
    @Inject(StagedIntentStore)
    private readonly staged: StagedIntentStore | null = null,
  ) {
    this.retentionMs = this.config.get<number>('STAGED_RETENTION_MS') ?? 86_400_000;
    this.unreceivedTtlMs = this.config.get<number>('STAGED_UNRECEIVED_TTL_MS') ?? 7 * 86_400_000;
  }

  @Interval(REAP_INTERVAL_MS)
  async reap(): Promise<void> {
    if (!this.staged || this.reaping) return;
    this.reaping = true;
    try {
      const now = Date.now();
      const expired = await this.staged.expireDue(now);
      const orphaned = await this.staged.expireUnreceived(now - this.unreceivedTtlMs, now);
      this.metrics.recordOrphanExpired(orphaned.length);
      const purged = await this.staged.purgeTerminal(now - this.retentionMs);
      if (expired > 0) {
        this.logger.warn(`Expired ${expired} past-deadline intent(s) that never stored`);
      }
      if (orphaned.length > 0) {
        this.logger.warn(
          `Expired ${orphaned.length} intent(s) whose Sui IntentReceived never arrived ` +
            `within ${Math.round(this.unreceivedTtlMs / 3_600_000)}h (forward delivery ` +
            `lost or skipped): ${orphaned.slice(0, 20).join(', ')}` +
            (orphaned.length > 20 ? ` (+${orphaned.length - 20} more)` : ''),
        );
      }
      if (purged > 0) {
        this.logger.log(`Purged ${purged} terminal row(s) past retention`);
      }
      // Publish queue depth after the janitorial passes so the gauges reflect the
      // post-reap state.
      this.metrics.setStagedQueueStats(await this.staged.stats());
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
