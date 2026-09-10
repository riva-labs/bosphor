import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { BreakEvenGuardService } from './break-even-guard.service';
import { PRICE_ORACLE } from '../pricing/pricing.module';
import { WalrusService } from '../walrus/walrus.service';
import { PriceSet } from '../pricing/price-oracle.types';

const PRICES: PriceSet = {
  WAL: { token: 'WAL', usd: 0.03, publishTimeMs: 0, source: 'test' },
  SUI: { token: 'SUI', usd: 0.8, publishTimeMs: 0, source: 'test' },
  ETH: { token: 'ETH', usd: 2500, publishTimeMs: 0, source: 'test' },
  SOL: { token: 'SOL', usd: 100, publishTimeMs: 0, source: 'test' },
};

describe('BreakEvenGuardService', () => {
  let service: BreakEvenGuardService;
  let mockGetPrices: jest.Mock;
  let mockEstimateWal: jest.Mock;

  beforeEach(async () => {
    mockGetPrices = jest.fn().mockResolvedValue(PRICES);
    mockEstimateWal = jest.fn().mockResolvedValue(34_840_000n);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BreakEvenGuardService,
        { provide: PRICE_ORACLE, useValue: { getPrices: mockGetPrices } },
        { provide: WalrusService, useValue: { estimateWalCostFrost: mockEstimateWal } },
        { provide: ConfigService, useValue: { get: (_k: string, d?: unknown) => d } },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {}, fatal() {} })
      .compile();

    service = module.get(BreakEvenGuardService);
  });

  it('proceeds when escrow covers live cost plus the default margin', async () => {
    const d = await service.check({
      escrowNative: 800_000_000_000_000n, // 0.0008 ETH = $2.00
      originToken: 'ETH',
      sizeBytes: 1024 * 1024,
      returnLzFeeMist: 1_760_000_000n,
      suiGasMist: 10_000_000n,
    });
    expect(mockEstimateWal).toHaveBeenCalledWith(1024 * 1024, undefined);
    expect(d.proceed).toBe(true);
  });

  it('skips when the recomputed live cost outruns the escrow', async () => {
    const d = await service.check({
      escrowNative: 400_000_000_000_000n, // 0.0004 ETH = $1.00 < cost
      originToken: 'ETH',
      sizeBytes: 1024 * 1024,
      returnLzFeeMist: 1_760_000_000n,
      suiGasMist: 10_000_000n,
    });
    expect(d.proceed).toBe(false);
  });

  it('fails loud when prices are unavailable (never spends on a guess)', async () => {
    mockGetPrices.mockRejectedValue(new Error('all price sources failed'));
    await expect(
      service.check({
        escrowNative: 800_000_000_000_000n,
        originToken: 'ETH',
        sizeBytes: 1024,
        returnLzFeeMist: 0n,
        suiGasMist: 0n,
      }),
    ).rejects.toThrow(/price sources/);
  });
});
