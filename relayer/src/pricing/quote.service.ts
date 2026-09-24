import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { WALRUS_MIN_EPOCHS } from '../walrus/store-epochs';
import { ConfigService } from '@nestjs/config';
import { WalrusService } from '../walrus/walrus.service';
import { PRICE_ORACLE } from './pricing.tokens';
import { PriceOracle } from './price-oracle';
import { OriginToken, Quote, QuoteConfig, QuoteEngine } from './quote-engine';

export interface QuoteRequest {
  /** Blob size in bytes. */
  sizeBytes: number;
  /**
   * Storage epochs the intent will commit. The relayer stores for exactly this
   * duration, so the quote is priced on it. Defaults to WALRUS_STORE_EPOCHS.
   */
  epochs?: number;
  /** Origin chain native token. */
  originToken: OriginToken;
  /** Forward LZ nativeFee (origin smallest unit) from the adapter quote. */
  forwardLzFeeNative?: bigint;
  /** Origin tx gas (origin smallest unit). */
  originGasNative?: bigint;
}

/**
 * Assembles a live origin-native quote: WAL cost from fresh on-chain state,
 * USD prices from the multi-source oracle, and the return-leg / Sui-gas
 * estimates from config, fed through the pure QuoteEngine. All quoting is off
 * chain; the on-chain contracts hold no oracle.
 */
@Injectable()
export class QuoteService {
  constructor(
    @Inject(PRICE_ORACLE) private readonly oracle: PriceOracle,
    private readonly walrus: WalrusService,
    private readonly config: ConfigService,
  ) {}

  private engineConfig(): QuoteConfig {
    return {
      buffers: {
        returnLeg: this.config.get<number>('QUOTE_BUFFER_RETURN_LEG', 0.2),
        suiGas: this.config.get<number>('QUOTE_BUFFER_SUI_GAS', 0.2),
        wal: this.config.get<number>('QUOTE_BUFFER_WAL', 0.1),
        crossRate: this.config.get<number>('QUOTE_BUFFER_CROSS_RATE', 0.05),
      },
      serviceMarginRatio: this.config.get<number>('QUOTE_SERVICE_MARGIN', 0.15),
      minChargeUsd: this.config.get<number>('QUOTE_MIN_CHARGE_USD', 0.02),
    };
  }

  async quote(req: QuoteRequest): Promise<Quote> {
    // Refuse to quote a duration the relayer will not store: such an intent would
    // be dead-lettered before any spend and only refund on its deadline.
    const max = this.walrus.maxStoreEpochs;
    if (
      req.epochs !== undefined &&
      (!Number.isInteger(req.epochs) || req.epochs < 0 || req.epochs > max)
    ) {
      throw new BadRequestException(
        `epochs must be an integer between 0 and ${max} (got ${req.epochs})`,
      );
    }
    // A committed 0 is valid on-chain and stored for the Walrus minimum of one
    // epoch, so price it as one (same rule as the store path).
    const epochs = req.epochs === undefined ? undefined : Math.max(req.epochs, WALRUS_MIN_EPOCHS);
    const prices = await this.oracle.getPrices();
    const walCostFrost = await this.walrus.estimateWalCostFrost(req.sizeBytes, epochs);

    // Return-leg fee and Sui gas are estimated here for the quote; the break-even
    // guard (#390) recomputes them at execution time against live values before
    // any WAL spend, so a stale estimate here never causes a loss.
    const returnLzFeeMist = BigInt(
      this.config.get<string>('QUOTE_RETURN_LZ_FEE_MIST', '1760000000'),
    );
    const suiGasMist = BigInt(this.config.get<string>('QUOTE_SUI_GAS_MIST', '30000000'));

    const engine = new QuoteEngine(this.engineConfig());
    return engine.quote(
      {
        originToken: req.originToken,
        walCostFrost,
        returnLzFeeMist,
        suiGasMist,
        forwardLzFeeNative: req.forwardLzFeeNative ?? 0n,
        originGasNative: req.originGasNative ?? 0n,
      },
      prices,
    );
  }
}
