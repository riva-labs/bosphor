import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalrusService } from './walrus.service';
import { SuiService } from '../chain/sui/sui.service';

describe('WalrusService', () => {
  let service: WalrusService;
  let mockSui: Partial<SuiService>;
  let mockWriteBlob: jest.Mock;
  let mockReset: jest.Mock;
  let mockSystemState: jest.Mock;
  let mockConfigGet: jest.Mock;

  beforeEach(async () => {
    mockWriteBlob = jest.fn();
    mockReset = jest.fn();
    // Default: no system state available -> cost is unknown (undefined), never a
    // fabricated zero. The cost-population test overrides this with live prices.
    mockSystemState = jest.fn().mockRejectedValue(new Error('no system state in test'));
    mockConfigGet = jest.fn((_key: string, defaultValue?: any) => defaultValue);

    mockSui = {
      getAddress: jest.fn().mockReturnValue('0xrelayeraddr'),
      getWalrusClient: jest.fn().mockReturnValue({
        walrus: { writeBlob: mockWriteBlob, reset: mockReset, systemState: mockSystemState },
      }),
      getSigner: jest.fn().mockReturnValue('mock-signer'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalrusService,
        { provide: SuiService, useValue: mockSui },
        {
          provide: ConfigService,
          useValue: { get: mockConfigGet },
        },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {}, fatal() {} })
      .compile();

    service = module.get<WalrusService>(WalrusService);
    service.onModuleInit();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('upload', () => {
    it('should call writeBlob and map result to WalrusBlobInfo', async () => {
      mockWriteBlob.mockResolvedValue({
        blobId: 'blob123',
        blobObject: {
          id: '0xblobobj',
          storage: { end_epoch: 50 },
        },
      });

      const result = await service.upload(Buffer.from('test-data'));

      expect(result).toEqual({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      });

      expect(mockWriteBlob).toHaveBeenCalledWith({
        blob: new Uint8Array(Buffer.from('test-data')),
        deletable: true,
        epochs: 5,
        signer: 'mock-signer',
        owner: '0xrelayeraddr',
      });
    });

    it('should populate the real WAL cost (FROST) from live system state', async () => {
      // Metering hook for the M4 user-pays model: the store cost is recomputed
      // from the same fresh on-chain prices the write paid against, never faked.
      mockSystemState.mockResolvedValue({
        committee: { n_shards: 1000 },
        storage_price_per_unit_size: '100000',
        write_price_per_unit_size: '20000',
      });
      mockWriteBlob.mockResolvedValue({
        blobId: 'blobCost',
        blobObject: { id: '0xcost', storage: { end_epoch: 90 } },
      });

      // 1 MiB blob at the default 5 epochs -> 67 storage units.
      const result = await service.upload(Buffer.alloc(1024 * 1024));

      // storage 67*100000*5 + write 67*20000 = 33_500_000 + 1_340_000
      expect(result.walCostMist).toBe(34_840_000n);
      expect(mockSystemState).toHaveBeenCalled();
    });

    it('should leave WAL cost undefined (unknown) when live state is unavailable', async () => {
      // No fabricated zero: if the cost cannot be computed, callers must see
      // undefined and treat it as unknown, not free.
      mockWriteBlob.mockResolvedValue({
        blobId: 'blobNoCost',
        blobObject: { id: '0xnocost', storage: { end_epoch: 91 } },
      });

      const result = await service.upload(Buffer.from('data'));

      expect(result.walCostMist).toBeUndefined();
    });

    it('should reset the SDK cache before every upload so payment uses live state', async () => {
      // The cache goes stale at each Walrus epoch rollover; resetting before the
      // write computes the storage payment from fresh on-chain state and kills
      // the whole stale-cache abort class regardless of its signature.
      mockWriteBlob.mockResolvedValue({
        blobId: 'blobFresh',
        blobObject: { id: '0xfresh', storage: { end_epoch: 80 } },
      });

      await service.upload(Buffer.from('fresh-data'));

      expect(mockReset).toHaveBeenCalledTimes(1);
      const resetOrder = mockReset.mock.invocationCallOrder[0];
      const writeOrder = mockWriteBlob.mock.invocationCallOrder[0];
      expect(resetOrder).toBeLessThan(writeOrder);
    });

    it('should use configured WALRUS_STORE_EPOCHS for upload', async () => {
      mockConfigGet.mockImplementation((key: string, defaultValue?: any) =>
        key === 'WALRUS_STORE_EPOCHS' ? 10 : defaultValue,
      );
      service.onModuleInit();

      mockWriteBlob.mockResolvedValue({
        blobId: 'blob123',
        blobObject: { id: '0xobj', storage: { end_epoch: 60 } },
      });

      await service.upload(Buffer.from('data'));

      expect(mockWriteBlob).toHaveBeenCalledWith(expect.objectContaining({ epochs: 10 }));
    });

    it('should reset the SDK cache and retry once on the stale-cache balance::split abort', async () => {
      // First attempt fails with the stale-epoch balance::split abort; after
      // reset() the retry succeeds against refreshed on-chain state.
      mockWriteBlob
        .mockRejectedValueOnce(
          new Error('MoveAbort in 4th command, abort code: 2, in 0x2::balance::split'),
        )
        .mockResolvedValueOnce({
          blobId: 'blobRetry',
          blobObject: { id: '0xobjRetry', storage: { end_epoch: 70 } },
        });

      const result = await service.upload(Buffer.from('retry-data'));

      // One proactive reset before the first write + one on the retry.
      expect(mockReset).toHaveBeenCalledTimes(2);
      expect(mockWriteBlob).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        blobId: 'blobRetry',
        suiObjectId: '0xobjRetry',
        endEpoch: 70,
      });
    });

    it('should reset and retry once on the balance::destroy_zero stale-cache abort', async () => {
      // The epoch-rollover abort surfaces as balance::destroy_zero (ENonZero,
      // code 0) when the stale price leaves a non-zero payment remainder. This is
      // the same stale-cache root cause as balance::split and must reset + retry.
      mockWriteBlob
        .mockRejectedValueOnce(
          new Error(
            'MoveAbort in 5th command, abort code: 0, in ' +
              "'0x0000000000000000000000000000000000000000000000000000000000000002::balance::destroy_zero' (instruction 8)",
          ),
        )
        .mockResolvedValueOnce({
          blobId: 'blobDz',
          blobObject: { id: '0xobjDz', storage: { end_epoch: 75 } },
        });

      const result = await service.upload(Buffer.from('dz-data'));

      expect(mockReset).toHaveBeenCalledTimes(2);
      expect(mockWriteBlob).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        blobId: 'blobDz',
        suiObjectId: '0xobjDz',
        endEpoch: 75,
      });
    });

    it('should NOT retry on a generic/transient error (writeBlob is not idempotent)', async () => {
      // A non-stale-cache error (e.g. a network failure after the blob may have
      // already been registered) must propagate without a blind retry, which
      // would mint a duplicate orphan blob and double-pay storage. The single
      // proactive reset still runs before the one attempt.
      mockWriteBlob.mockRejectedValue(new Error('socket hang up'));

      await expect(service.upload(Buffer.from('fail-data'))).rejects.toThrow('socket hang up');
      expect(mockReset).toHaveBeenCalledTimes(1);
      expect(mockWriteBlob).toHaveBeenCalledTimes(1);
    });

    it('should propagate when the stale-cache retry also fails', async () => {
      // No fabricated fallback: if reset + retry still fails, the error must
      // surface so the intent fails loudly rather than returning fake data.
      mockWriteBlob.mockRejectedValue(
        new Error('MoveAbort in 4th command, abort code: 2, in 0x2::balance::split'),
      );

      await expect(service.upload(Buffer.from('fail-data'))).rejects.toThrow('balance::split');
      // One proactive reset + one on the retry.
      expect(mockReset).toHaveBeenCalledTimes(2);
      expect(mockWriteBlob).toHaveBeenCalledTimes(2);
    });
  });
});
