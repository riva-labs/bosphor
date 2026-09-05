import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WalrusService } from '../walrus/walrus.service';
import { PRICE_ORACLE } from '../pricing/pricing.module';
import { PriceOracle } from '../pricing/price-oracle';
import { evaluateBreakEven, BreakEvenDecision } from '../pricing/break-even-guard';
import { OriginToken } from '../pricing/quote-engine';

export interface BreakEvenCheck {
  /** Escrowed amount for this intent, origin native smallest unit. */
  escrowNative: bigint;
  originToken: OriginToken;
  /** Blob size for the live WAL-cost recompute. */
  sizeBytes: number;
  epochs?: number;
  /** Live return-leg fee (SUI MIST) and Sui gas (SUI MIST) at execution time. */
  returnLzFeeMist: bigint;
  suiGasMist: bigint;
}

/**
 * The relayer-side never-lose-money gate. Call {@link check} immediately before
 * any WAL spend: it fetches live prices, recomputes the ACTUAL relayer-fronted
 * cost, and returns a decision. `proceed === false` means SKIP the spend so the
 * intent refunds to the user on its deadline and Bosphor is out nothing. Fails
 * loud (throws) if prices are unavailable, so a spend never rides on a guess.
 */
@Injectable()
export class BreakEvenGuardService {
  private readonly logger = new Logger(BreakEvenGuardService.name);

  constructor(
    @Inject(PRICE_ORACLE) private readonly oracle: PriceOracle,
    private readonly walrus: WalrusService,
    private readonly config: ConfigService,
  ) {}

  async check(params: BreakEvenCheck): Promise<BreakEvenDecision> {
    const prices = await this.oracle.getPrices();
    const walCostFrost = await this.walrus.estimateWalCostFrost(params.sizeBytes, params.epochs);
    const minMarginRatio = this.config.get<number>('BREAK_EVEN_MIN_MARGIN', 0.1);

    const decision = evaluateBreakEven({
      escrowNative: params.escrowNative,
      originToken: params.originToken,
      walCostFrost,
      returnLzFeeMist: params.returnLzFeeMist,
      suiGasMist: params.suiGasMist,
      minMarginRatio,
      prices,
    });

    if (!decision.proceed) {
      this.logger.warn(`Break-even guard skipping spend: ${decision.reason}`);
    }
    return decision;
  }
}
