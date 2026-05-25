import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { WalrusService } from './walrus.service';
import { SuiService } from '../chain/sui/sui.service';

describe('WalrusService', () => {
  let service: WalrusService;
  let mockSui: Partial<SuiService>;
  let mockFetch: jest.SpiedFunction<typeof global.fetch>;

  beforeEach(async () => {
    mockSui = {
      getAddress: jest.fn().mockReturnValue('0xrelayeraddr'),
      findBlobObject: jest.fn().mockResolvedValue('0xblobobj'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WalrusService,
        { provide: SuiService, useValue: mockSui },
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest.fn((key: string) => {
              const map: Record<string, string> = {
                WALRUS_PUBLISHER_URL: 'https://publisher.test',
                WALRUS_AGGREGATOR_URL: 'https://aggregator.test',
              };
              if (map[key]) return map[key];
              throw new Error(`Missing: ${key}`);
            }),
            get: jest.fn((_key: string, defaultValue?: any) => defaultValue),
          },
        },
      ],
    }).compile();

    service = module.get<WalrusService>(WalrusService);
    service.onModuleInit();

    mockFetch = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{}', { status: 200 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('upload', () => {
    it('should return blob info for newlyCreated response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          newlyCreated: {
            blobObject: {
              blobId: 'blob123',
              id: '0xblobobj',
              storage: { endEpoch: 50 },
            },
          },
        }),
      } as any);

      const result = await service.upload(Buffer.from('test-data'));

      expect(result).toEqual({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return blob info for alreadyCertified response', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          alreadyCertified: {
            blobId: 'certblob456',
            endEpoch: 30,
          },
        }),
      } as any);

      const result = await service.upload(Buffer.from('test-data'));

      expect(result).toEqual({
        blobId: 'certblob456',
        suiObjectId: '',
        endEpoch: 30,
      });
    });

    it(
      'should retry on 5xx and succeed',
      async () => {
        mockFetch
          .mockResolvedValueOnce({
            ok: false,
            status: 502,
            text: jest.fn().mockResolvedValue('Bad Gateway'),
          } as any)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: jest.fn().mockResolvedValue({
              newlyCreated: {
                blobObject: {
                  blobId: 'blob789',
                  id: '0xobj789',
                  storage: { endEpoch: 40 },
                },
              },
            }),
          } as any);

        const result = await service.upload(Buffer.from('retry-data'));

        expect(result.blobId).toBe('blob789');
        expect(mockFetch).toHaveBeenCalledTimes(2);
      },
      10_000,
    );

    it(
      'should throw after max retries on persistent 5xx',
      async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 500,
          text: jest.fn().mockResolvedValue('Internal Server Error'),
        } as any);

        await expect(
          service.upload(Buffer.from('fail-data')),
        ).rejects.toThrow('Walrus upload failed (500)');

        expect(mockFetch).toHaveBeenCalledTimes(3);
      },
      15_000,
    );

    it(
      'should retry on 4xx and throw after max attempts',
      async () => {
        mockFetch.mockResolvedValue({
          ok: false,
          status: 400,
          text: jest.fn().mockResolvedValue('Bad Request'),
        } as any);

        await expect(
          service.upload(Buffer.from('bad-data')),
        ).rejects.toThrow('Walrus upload failed (400)');

        expect(mockFetch).toHaveBeenCalledTimes(3);
      },
      15_000,
    );

    it(
      'should throw when all attempts time out',
      async () => {
        const abortError = new DOMException(
          'The operation was aborted',
          'AbortError',
        );
        mockFetch.mockRejectedValue(abortError);

        await expect(
          service.upload(Buffer.from('timeout-data')),
        ).rejects.toThrow();

        expect(mockFetch).toHaveBeenCalledTimes(3);
      },
      15_000,
    );

    it('should throw on unexpected response shape', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ unknownField: true }),
      } as any);

      await expect(
        service.upload(Buffer.from('weird-data')),
      ).rejects.toThrow('Unexpected Walrus response');
    });
  });

  describe('findBlobObject', () => {
    it('should delegate to SuiService', async () => {
      const result = await service.findBlobObject('blob123');

      expect(result).toBe('0xblobobj');
      expect(mockSui.findBlobObject).toHaveBeenCalledWith('blob123');
    });
  });

  describe('getAggregatorUrl', () => {
    it('should return the configured aggregator URL', () => {
      expect(service.getAggregatorUrl()).toBe('https://aggregator.test');
    });
  });
});
