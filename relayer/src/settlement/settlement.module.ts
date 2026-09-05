import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetricsModule } from '../metrics/metrics.module';
import { WalrusModule } from '../walrus/walrus.module';
import { PricingModule } from '../pricing/pricing.module';
import { BreakEvenGuardService } from './break-even-guard.service';
import { SettlementReconciler } from './settlement-reconciler.service';

/**
 * Never-lose-money enforcement: the break-even guard (pre-spend gate) and the
 * settlement reconciler (per-intent P&L + metrics). Provided app-wide so the
 * store pipeline can consult the guard before any WAL spend and book the outcome.
 */
@Module({
  imports: [ConfigModule, MetricsModule, WalrusModule, PricingModule],
  providers: [BreakEvenGuardService, SettlementReconciler],
  exports: [BreakEvenGuardService, SettlementReconciler],
})
export class SettlementModule {}
