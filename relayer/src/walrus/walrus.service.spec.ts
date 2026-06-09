import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalrusService } from './walrus.service';
import { SuiService } from '../chain/sui/sui.service';

describe('WalrusService', () => {
  let service: WalrusService;
  let mockSui: Partial<SuiService>;
  let mockWriteBlob: jest.Mock;
  let mockConfigGet: jest.Mock;

  beforeEach(async () => {
    mockWriteBlob = jest.fn();
    mockConfigGet = jest.fn((_key: string, defaultValue?: any) => defaultValue);

    mockSui = {
      getAddress: jest.fn().mockReturnValue('0xrelayeraddr'),
      getWalrusClient: jest.fn().mockReturnValue({
        walrus: { writeBlob: mockWriteBlob },
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

    it('should propagate errors from writeBlob', async () => {
      mockWriteBlob.mockRejectedValue(new Error('SDK upload failed'));

      await expect(service.upload(Buffer.from('fail-data'))).rejects.toThrow(
        'SDK upload failed',
      );
    });
  });
});
