import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { QuoteService } from './quote.service';
import { PRICE_ORACLE } from './pricing.module';
import { WalrusService } from '../walrus/walrus.service';
import { PriceSet } from './price-oracle.types';

const PRICES: PriceSet = {
  WAL: { token: 'WAL', usd: 0.03, publishTimeMs: 0, source: 'test' },
  SUI: { token: 'SUI', usd: 0.8, publishTimeMs: 0, source: 'test' },
  ETH: { token: 'ETH', usd: 2500, publishTimeMs: 0, source: 'test' },
  SOL: { token: 'SOL', usd: 100, publishTimeMs: 0, source: 'test' },
};

describe('QuoteService', () => {
  let service: QuoteService;
  let mockGetPrices: jest.Mock;
  let mockEstimateWal: jest.Mock;

  beforeEach(async () => {
    mockGetPrices = jest.fn().mockResolvedValue(PRICES);
    mockEstimateWal = jest.fn().mockResolvedValue(34_840_000n);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QuoteService,
        { provide: PRICE_ORACLE, useValue: { getPrices: mockGetPrices } },
        { provide: WalrusService, useValue: { estimateWalCostFrost: mockEstimateWal } },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string, def?: unknown) => {
              const cfg: Record<string, unknown> = {
                QUOTE_RETURN_LZ_FEE_MIST: '1760000000',
                QUOTE_SUI_GAS_MIST: '10000000',
              };
              return key in cfg ? cfg[key] : def;
            },
          },
        },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {}, fatal() {} })
      .compile();

    service = module.get(QuoteService);
  });

  it('assembles a live quote from oracle prices and estimated WAL cost', async () => {
    const q = await service.quote({
      sizeBytes: 1024 * 1024,
      originToken: 'ETH',
      forwardLzFeeNative: 1_211_000_000_000_000n,
      originGasNative: 40_000_000_000_000n,
    });

    expect(mockEstimateWal).toHaveBeenCalledWith(1024 * 1024, undefined);
    expect(mockGetPrices).toHaveBeenCalled();
    expect(q.breakdown.escrowUsd).toBeCloseTo(2.0531062, 4);
    expect(q.forwardNative).toBe(1_251_000_000_000_000n);
    expect(q.escrowNative).toBeGreaterThan(0n);
  });

  it('propagates an oracle failure (no fabricated quote)', async () => {
    mockGetPrices.mockRejectedValue(new Error('all price sources failed'));
    await expect(service.quote({ sizeBytes: 1024, originToken: 'ETH' })).rejects.toThrow(
      /price sources/,
    );
  });
});
