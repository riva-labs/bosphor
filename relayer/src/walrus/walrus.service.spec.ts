import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalrusService } from './walrus.service';
import { SuiService } from '../chain/sui/sui.service';

describe('WalrusService', () => {
  let service: WalrusService;
  let mockSui: Partial<SuiService>;
  let mockWriteBlob: jest.Mock;
  let mockReset: jest.Mock;
  let mockConfigGet: jest.Mock;

  beforeEach(async () => {
    mockWriteBlob = jest.fn();
    mockReset = jest.fn();
    mockConfigGet = jest.fn((_key: string, defaultValue?: any) => defaultValue);

    mockSui = {
      getAddress: jest.fn().mockReturnValue('0xrelayeraddr'),
      getWalrusClient: jest.fn().mockReturnValue({
        walrus: { writeBlob: mockWriteBlob, reset: mockReset },
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

      expect(mockWriteBlob).toHaveBeenCalledWith(
        expect.objectContaining({ epochs: 10 }),
      );
    });

    it('should reset the SDK cache and retry once when writeBlob fails (Walrus epoch change)', async () => {
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

      expect(mockReset).toHaveBeenCalledTimes(1);
      expect(mockWriteBlob).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        blobId: 'blobRetry',
        suiObjectId: '0xobjRetry',
        endEpoch: 70,
      });
    });

    it('should propagate the error when the retry also fails', async () => {
      // No fabricated fallback: if reset + retry still fails, the error must
      // surface so the intent fails loudly rather than returning fake data.
      mockWriteBlob.mockRejectedValue(new Error('SDK upload failed'));

      await expect(service.upload(Buffer.from('fail-data'))).rejects.toThrow(
        'SDK upload failed',
      );
      expect(mockReset).toHaveBeenCalledTimes(1);
      expect(mockWriteBlob).toHaveBeenCalledTimes(2);
    });
  });
});
