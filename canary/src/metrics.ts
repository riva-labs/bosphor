import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { SkipReason } from './preflight.ts';

export type CanaryStage = 'forward_delivery' | 'return_delivery';

/** Origin chain a probe runs against. The label that lets one canary cover many chains. */
export type CanaryChain = 'evm' | 'solana';

/**
 * Prometheus metrics for the synthetic canary, exposed on its own /metrics
 * endpoint (scraped under job=bosphor-canary). Owns a private registry so it
 * can be instantiated more than once (e.g. in tests) without colliding on the
 * global default registry.
 *
 * Round-trip health carries a `chain` label so a single canary can probe every
 * origin (EVM, Solana, ...) and Grafana can break the series out per chain or
 * aggregate across them. The wallet-balance and gas gauges stay chain-specific
 * by name (`_eth`/`_gwei` for EVM, `_sol` for Solana) because their units
 * differ; keeping the EVM names unchanged means the existing alerts and panels
 * keep working as-is.
 */
export class CanaryMetrics {
  private readonly registry = new Registry();

  private readonly roundtripTotal = new Counter({
    name: 'bosphor_canary_roundtrip_total',
    help: 'Synthetic round-trips by origin chain and result',
    labelNames: ['chain', 'result'] as const,
    registers: [this.registry],
  });

  private readonly roundtripDuration = new Histogram({
    name: 'bosphor_canary_roundtrip_duration_seconds',
    help: 'Full synthetic round-trip duration in seconds, by origin chain',
    labelNames: ['chain'] as const,
    buckets: [10, 30, 60, 120, 300, 600, 900],
    registers: [this.registry],
  });

  private readonly stageDuration = new Histogram({
    name: 'bosphor_canary_stage_duration_seconds',
    help: 'Per-stage round-trip duration in seconds, by origin chain',
    labelNames: ['chain', 'stage'] as const,
    buckets: [1, 5, 15, 30, 60, 120, 300, 600],
    registers: [this.registry],
  });

  private readonly lastSuccess = new Gauge({
    name: 'bosphor_canary_last_success_timestamp_seconds',
    help: 'Unix time of the last successful round-trip, by origin chain',
    labelNames: ['chain'] as const,
    registers: [this.registry],
  });

  private readonly walletBalanceEth = new Gauge({
    name: 'bosphor_canary_wallet_balance_eth',
    help: 'EVM sender wallet balance in ETH (native gas token)',
    registers: [this.registry],
  });

  private readonly walletBalanceSol = new Gauge({
    name: 'bosphor_canary_wallet_balance_sol',
    help: 'Solana sender wallet balance in SOL (native gas token)',
    registers: [this.registry],
  });

  private readonly gasPrice = new Gauge({
    name: 'bosphor_canary_gas_price_gwei',
    help: 'Current EVM network gas price (maxFeePerGas) in gwei',
    registers: [this.registry],
  });

  private readonly skipped = new Counter({
    name: 'bosphor_canary_skipped_total',
    help: 'Probes skipped by the preflight guard, by origin chain and reason',
    labelNames: ['chain', 'reason'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  recordSuccess(chain: CanaryChain, roundtripSeconds: number, nowSeconds: number): void {
    this.roundtripTotal.inc({ chain, result: 'success' });
    this.roundtripDuration.observe({ chain }, roundtripSeconds);
    this.lastSuccess.set({ chain }, nowSeconds);
  }

  recordFailure(chain: CanaryChain): void {
    this.roundtripTotal.inc({ chain, result: 'failure' });
  }

  observeStage(chain: CanaryChain, stage: CanaryStage, seconds: number): void {
    this.stageDuration.observe({ chain, stage }, seconds);
  }

  /** Publish the latest EVM wallet balance (ETH). No-op on a failed read (NaN). */
  setWalletBalanceEth(eth: number): void {
    if (Number.isFinite(eth)) this.walletBalanceEth.set(eth);
  }

  /** Publish the latest Solana wallet balance (SOL). No-op on a failed read (NaN). */
  setWalletBalanceSol(sol: number): void {
    if (Number.isFinite(sol)) this.walletBalanceSol.set(sol);
  }

  /** Publish the latest EVM gas price (gwei). No-op on a failed read (NaN). */
  setGasPrice(gwei: number): void {
    if (Number.isFinite(gwei)) this.gasPrice.set(gwei);
  }

  /** Count a probe the preflight guard skipped, labelled by chain and reason. */
  recordSkip(chain: CanaryChain, reason: SkipReason): void {
    this.skipped.inc({ chain, reason });
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  getMetrics(): Promise<string> {
    return this.registry.metrics();
  }
}
