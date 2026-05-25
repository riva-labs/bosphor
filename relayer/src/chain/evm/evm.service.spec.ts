import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EvmService } from './evm.service';

describe('EvmService', () => {
  let service: EvmService;
  let mockProvider: any;
  let mockAdapter: any;

  beforeEach(async () => {
    mockProvider = {
      getBlockNumber: jest.fn().mockResolvedValue(1000),
    };

    mockAdapter = {
      filters: {
        IntentSubmitted: jest.fn().mockReturnValue('mock-filter'),
      },
      queryFilter: jest.fn().mockResolvedValue([]),
      interface: {
        parseLog: jest.fn(),
      },
      confirmExecution: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EvmService,
        {
          provide: ConfigService,
          useValue: { getOrThrow: jest.fn() },
        },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {}, fatal() {} })
      .compile();

    service = module.get<EvmService>(EvmService);
    // Skip onModuleInit, set internal dependencies directly
    (service as any).provider = mockProvider;
    (service as any).adapter = mockAdapter;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getBlockNumber', () => {
    it('should return the current block number from provider', async () => {
      const blockNumber = await service.getBlockNumber();

      expect(blockNumber).toBe(1000);
      expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(1);
    });
  });

  describe('pollEvents', () => {
    it('should return empty events when fromBlock > latestBlock', async () => {
      const result = await service.pollEvents(1001);

      expect(result).toEqual({ events: [], newFromBlock: 1001 });
      expect(mockAdapter.queryFilter).not.toHaveBeenCalled();
    });

    it('should return parsed events from contract logs', async () => {
      const mockLog = {
        topics: ['0xtopic0', '0xintentid', '0xsender'],
        data: '0xdata',
      };
      mockAdapter.queryFilter.mockResolvedValue([mockLog]);
      mockAdapter.interface.parseLog.mockReturnValue({
        args: {
          intentId: '0x' + 'ab'.repeat(32),
          sender: '0x' + '11'.repeat(20),
          targetChainId: 1n,
          payload: '0xdeadbeef',
          nonce: 1n,
          deadline: 1000000n,
        },
      });

      const result = await service.pollEvents(900);

      expect(result.events).toHaveLength(1);
      expect(result.events[0]).toEqual({
        intentId: '0x' + 'ab'.repeat(32),
        sender: '0x' + '11'.repeat(20),
        targetChainId: 1n,
        payload: '0xdeadbeef',
        nonce: 1n,
        deadline: 1000000n,
      });
      expect(result.newFromBlock).toBe(1001);
    });

    it('should skip logs that fail to parse', async () => {
      mockAdapter.queryFilter.mockResolvedValue([
        { topics: ['0xtopic0'], data: '0xdata' },
      ]);
      mockAdapter.interface.parseLog.mockReturnValue(null);

      const result = await service.pollEvents(900);

      expect(result.events).toHaveLength(0);
      expect(result.newFromBlock).toBe(1001);
    });
  });

  describe('confirmExecution', () => {
    it('should send transaction and return hash', async () => {
      const mockTx = {
        wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
      };
      mockAdapter.confirmExecution.mockResolvedValue(mockTx);

      const hash = await service.confirmExecution('0xintentid', 'proof-data');

      expect(hash).toBe('0xtxhash');
      expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(1);
    });

    it(
      'should retry on transient failure and succeed',
      async () => {
        const mockTx = {
          wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
        };
        mockAdapter.confirmExecution
          .mockRejectedValueOnce(new Error('nonce too low'))
          .mockResolvedValueOnce(mockTx);

        const hash = await service.confirmExecution('0xintentid', 'proof-data');

        expect(hash).toBe('0xtxhash');
        expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(2);
      },
      10_000,
    );

    it(
      'should throw after max retries',
      async () => {
        mockAdapter.confirmExecution.mockRejectedValue(
          new Error('persistent error'),
        );

        await expect(
          service.confirmExecution('0xintentid', 'proof-data'),
        ).rejects.toThrow('persistent error');

        expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(3);
      },
      10_000,
    );
  });
});
