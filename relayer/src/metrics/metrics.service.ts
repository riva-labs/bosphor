import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

type Result = 'success' | 'failure';
type IntentPath = 'evm' | 'sui_lz';

@Injectable()
export class MetricsService {
  private readonly registry = new Registry();

  private readonly intentsProcessed = new Counter({
    name: 'bosphor_relayer_intents_processed_total',
    help: 'Intents processed by the relayer, by source path and result',
    labelNames: ['result', 'path'] as const,
    registers: [this.registry],
  });

  private readonly lzSend = new Counter({
    name: 'bosphor_relayer_lz_send_total',
    help: 'LayerZero proof sends from the relayer, by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  private readonly checkpointCursorLag = new Gauge({
    name: 'bosphor_relayer_checkpoint_cursor_lag',
    help: 'Latest Sui checkpoint minus the processed cursor',
    registers: [this.registry],
  });

  private readonly walrusUpload = new Histogram({
    name: 'bosphor_relayer_walrus_upload_seconds',
    help: 'Walrus upload duration in seconds',
    buckets: [0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [this.registry],
  });

  private readonly walBalance = new Gauge({
    name: 'bosphor_relayer_wal_balance_wal',
    help: 'Relayer WAL balance in WAL (the Walrus storage token)',
    registers: [this.registry],
  });

  private readonly suiBalance = new Gauge({
    name: 'bosphor_relayer_sui_balance_sui',
    help: 'Relayer SUI balance in SUI (gas + WAL swap funding)',
    registers: [this.registry],
  });

  private readonly walTopUp = new Counter({
    name: 'bosphor_relayer_wal_topup_total',
    help: 'WAL auto top-up attempts by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  // Per-intent WAL storage cost, in MIST. Metering hook for the Milestone 4
  // user-pays model: today the relayer absorbs this cost, so tracking it per
  // fulfilled intent is what M4 will turn into a charge without reworking the
  // fulfillment path. The running total is exposed for cost dashboards.
  private readonly walStorageCost = new Counter({
    name: 'bosphor_relayer_wal_storage_cost_mist_total',
    help: 'Total WAL spent on blob storage across fulfilled intents, in MIST',
    registers: [this.registry],
  });

  // Dead-letter / undelivered events on the durable store queue. `pre_store`
  // means the blob never stored (attempts exhausted or terminal) and is settled
  // dead; `return` means the blob stored but its proof could not be delivered
  // within the return-leg budget (storage is safe, alert to redeliver). The
  // Grafana panel + alert for these land with the metrics slice.
  private readonly storeDeadLetter = new Counter({
    name: 'bosphor_relayer_store_dead_letter_total',
    help: 'Durable-queue intents that dead-lettered or exceeded the return budget',
    labelNames: ['phase'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
    // Initialize the top-up counter series to 0 for every result so the WAL
    // auto top-up panel renders a flat 0 line instead of "No data" until the
    // first top-up actually fires (which only happens when WAL drops low).
    for (const result of ['success', 'failure', 'insufficient_sui'] as const) {
      this.walTopUp.inc({ result }, 0);
    }
  }

  recordIntentProcessed(path: IntentPath, result: Result): void {
    this.intentsProcessed.inc({ result, path });
  }

  recordLzSend(result: Result): void {
    this.lzSend.inc({ result });
  }

  setCheckpointCursorLag(lag: number): void {
    this.checkpointCursorLag.set(lag);
  }

  observeWalrusUpload(seconds: number): void {
    this.walrusUpload.observe(seconds);
  }

  setWalBalance(wal: number): void {
    if (Number.isFinite(wal)) this.walBalance.set(wal);
  }

  setSuiBalance(sui: number): void {
    if (Number.isFinite(sui)) this.suiBalance.set(sui);
  }

  recordWalTopUp(result: 'success' | 'failure' | 'insufficient_sui'): void {
    this.walTopUp.inc({ result });
  }

  /**
   * Record the WAL cost (MIST) of storing one intent's blob. Metering hook for
   * the M4 user-pays model; a no-op guard keeps a missing/negative cost from
   * corrupting the counter.
   */
  recordWalStorageCost(costMist: number): void {
    if (Number.isFinite(costMist) && costMist >= 0) this.walStorageCost.inc(costMist);
  }

  /** Record a durable-queue dead-letter (pre-store) or return-budget exhaustion. */
  recordDeadLetter(phase: 'pre_store' | 'return'): void {
    this.storeDeadLetter.inc({ phase });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
