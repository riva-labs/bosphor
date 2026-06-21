import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export type CanaryStage = 'forward_delivery' | 'return_delivery';

/**
 * Prometheus metrics for the synthetic canary, exposed on its own /metrics
 * endpoint (scraped under job=bosphor-canary). Owns a private registry so it
 * can be instantiated more than once (e.g. in tests) without colliding on the
 * global default registry.
 */
export class CanaryMetrics {
  private readonly registry = new Registry();

  private readonly roundtripTotal = new Counter({
    name: 'bosphor_canary_roundtrip_total',
    help: 'Synthetic round-trips by result',
    labelNames: ['result'] as const,
    registers: [this.registry],
  });

  private readonly roundtripDuration = new Histogram({
    name: 'bosphor_canary_roundtrip_duration_seconds',
    help: 'Full synthetic round-trip duration in seconds',
    buckets: [10, 30, 60, 120, 300, 600, 900],
    registers: [this.registry],
  });

  private readonly stageDuration = new Histogram({
    name: 'bosphor_canary_stage_duration_seconds',
    help: 'Per-stage round-trip duration in seconds',
    labelNames: ['stage'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600],
    registers: [this.registry],
  });

  private readonly lastSuccess = new Gauge({
    name: 'bosphor_canary_last_success_timestamp_seconds',
    help: 'Unix time of the last successful round-trip',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  recordSuccess(roundtripSeconds: number, nowSeconds: number): void {
    this.roundtripTotal.inc({ result: 'success' });
    this.roundtripDuration.observe(roundtripSeconds);
    this.lastSuccess.set(nowSeconds);
  }

  recordFailure(): void {
    this.roundtripTotal.inc({ result: 'failure' });
  }

  observeStage(stage: CanaryStage, seconds: number): void {
    this.stageDuration.observe({ stage }, seconds);
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
