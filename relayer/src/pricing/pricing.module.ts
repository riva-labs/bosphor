import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WalrusModule } from '../walrus/walrus.module';
import { PriceOracle } from './price-oracle';
import { PriceOracleConfig, SanityBounds } from './price-oracle.types';
import { QuoteService } from './quote.service';
import { QuoteController } from './quote.controller';

export const PRICE_ORACLE = 'PRICE_ORACLE';

// Chain-agnostic Pyth feed ids (hex, no 0x), pinned 2026-09-05.
const DEFAULT_PYTH_FEEDS = {
  WAL: 'eba0732395fae9dec4bae12e52760b35fc1c5671e2da8b449c9af4efe5d54341',
  SUI: '23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
  ETH: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  SOL: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
};

const DEFAULT_COINGECKO_IDS = {
  WAL: 'walrus-2',
  SUI: 'sui',
  ETH: 'ethereum',
  SOL: 'solana',
};

// Wide absolute plausibility bounds (USD): a value outside means a broken feed,
// not a market move. Not a price target, just a loud-failure backstop.
const DEFAULT_SANITY_BOUNDS: SanityBounds = {
  WAL: { min: 0.0005, max: 50 },
  SUI: { min: 0.02, max: 100 },
  ETH: { min: 50, max: 1_000_000 },
  SOL: { min: 1, max: 100_000 },
};

/**
 * Provides a configured PriceOracle to the relayer. Sources and bounds come from
 * env with pinned defaults; the oracle itself fails loud, so misconfiguration
 * surfaces as a thrown error rather than a bad quote.
 */
@Module({
  imports: [ConfigModule, WalrusModule],
  controllers: [QuoteController],
  providers: [
    QuoteService,
    {
      provide: PRICE_ORACLE,
      inject: [ConfigService],
      useFactory: (config: ConfigService): PriceOracle => {
        const oracleConfig: PriceOracleConfig = {
          maxStalenessMs: config.get<number>('PRICE_MAX_STALENESS_MS', 120_000),
          maxDeviationRatio: config.get<number>('PRICE_MAX_DEVIATION_RATIO', 0.15),
          sanityBounds: DEFAULT_SANITY_BOUNDS,
          pyth: {
            url: config.get<string>(
              'PYTH_HERMES_URL',
              'https://hermes.pyth.network/v2/updates/price/latest',
            ),
            apiKey: config.get<string>('PYTH_HERMES_API_KEY') || undefined,
            feedIds: DEFAULT_PYTH_FEEDS,
          },
          coingecko: {
            url: config.get<string>(
              'COINGECKO_URL',
              'https://api.coingecko.com/api/v3/simple/price',
            ),
            apiKey: config.get<string>('COINGECKO_API_KEY') || undefined,
            ids: DEFAULT_COINGECKO_IDS,
          },
        };
        return new PriceOracle(oracleConfig);
      },
    },
  ],
  exports: [PRICE_ORACLE, QuoteService],
})
export class PricingModule {}
