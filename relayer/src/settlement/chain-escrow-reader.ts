import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EscrowInfo, EscrowReader } from './escrow-reader';

/** Minimal EVM escrow-read surface (satisfied by EvmService). */
export interface EvmEscrowSource {
  getEscrow(intentId: string): Promise<{ token: string; amount: bigint; status: number } | null>;
}

/** Minimal Solana escrow-read surface (satisfied by SolanaService). */
export interface SolanaEscrowSource {
  getEscrow(intentId: string): Promise<{ amount: bigint; status: number } | null>;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Reads an intent's on-chain escrow terms from the deployed escrow adapters:
 * the EVM `getEscrow(intentId)` view for EVM-origin intents and the Solana escrow
 * vault PDA for Solana-origin intents (routed by srcEid). Maps the raw record to
 * the guard's {@link EscrowInfo}. Returns null (guard not applied) when there is
 * no escrow, so pre-escrow or unpriced intents flow unchanged.
 *
 * Only native escrows drive the break-even guard today; a non-native (USDC) EVM
 * escrow returns null here (its USD coverage is validated on the token path, a
 * fast-follow), never a mis-priced native amount.
 */
@Injectable()
export class ChainEscrowReader implements EscrowReader {
  private readonly solanaSrcEid: number;

  constructor(
    @Inject('EVM_ESCROW_SOURCE') private readonly evm: EvmEscrowSource,
    @Inject('SOLANA_ESCROW_SOURCE') private readonly solana: SolanaEscrowSource,
    config: ConfigService,
  ) {
    this.solanaSrcEid = config.get<number>('SOLANA_SRC_EID') ?? 40168;
  }

  async getEscrow(intentId: string, srcEid?: number): Promise<EscrowInfo | null> {
    if (srcEid === this.solanaSrcEid) {
      const e = await this.solana.getEscrow(intentId);
      if (!e || e.amount <= 0n) return null;
      return { escrowNative: e.amount, originToken: 'SOL' };
    }
    const e = await this.evm.getEscrow(intentId);
    if (!e || e.amount <= 0n) return null;
    // Native only for the guard; a token (USDC) escrow is handled on the token path.
    if (e.token.toLowerCase() !== ZERO_ADDRESS) return null;
    return { escrowNative: e.amount, originToken: 'ETH' };
  }
}
