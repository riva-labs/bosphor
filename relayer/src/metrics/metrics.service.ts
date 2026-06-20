import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

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

  get contentType(): string {
    return this.registry.contentType;
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
