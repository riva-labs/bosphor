import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MetricsModule } from '../metrics/metrics.module';
import { WalrusModule } from '../walrus/walrus.module';
import { PricingModule } from '../pricing/pricing.module';
import { EvmModule } from '../chain/evm/evm.module';
import { SolanaModule } from '../chain/solana/solana.module';
import { EvmService } from '../chain/evm/evm.service';
import { SolanaService } from '../chain/solana/solana.service';
import { BreakEvenGuardService } from './break-even-guard.service';
import { SettlementReconciler } from './settlement-reconciler.service';
import { ChainEscrowReader } from './chain-escrow-reader';
import { ESCROW_READER } from './escrow-reader';

/**
 * Never-lose-money enforcement: the break-even guard (pre-spend gate), the
 * settlement reconciler (per-intent P&L + metrics), and the on-chain escrow
 * reader that feeds the guard. Provided app-wide so the store pipeline can
 * consult the guard before any WAL spend and book the outcome.
 *
 * The escrow reader is wired but the guard only reads it when
 * BREAK_EVEN_GUARD_ENABLED is set; until then, and until the escrow adapters are
 * deployed, getEscrow returns null and the guard is simply not applied.
 */
@Module({
  imports: [ConfigModule, MetricsModule, WalrusModule, PricingModule, EvmModule, SolanaModule],
  providers: [
    BreakEvenGuardService,
    SettlementReconciler,
    { provide: 'EVM_ESCROW_SOURCE', useExisting: EvmService },
    { provide: 'SOLANA_ESCROW_SOURCE', useExisting: SolanaService },
    { provide: ESCROW_READER, useClass: ChainEscrowReader },
  ],
  exports: [BreakEvenGuardService, SettlementReconciler, ESCROW_READER],
})
export class SettlementModule {}
