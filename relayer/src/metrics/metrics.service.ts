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

  constructor() {
    collectDefaultMetrics({ register: this.registry });
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

  get contentType(): string {
    return this.registry.contentType;
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
