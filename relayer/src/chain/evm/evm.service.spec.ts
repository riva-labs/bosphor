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
      // Head is 1000 but we stay 3 blocks behind: latest = 997, cursor -> 998.
      expect(result.newFromBlock).toBe(998);
    });

    it('should skip logs that fail to parse', async () => {
      mockAdapter.queryFilter.mockResolvedValue([{ topics: ['0xtopic0'], data: '0xdata' }]);
      mockAdapter.interface.parseLog.mockReturnValue(null);

      const result = await service.pollEvents(900);

      expect(result.events).toHaveLength(0);
      expect(result.newFromBlock).toBe(998);
    });

    it('should query up to EVM_HEAD_LAG blocks behind head, not to head', async () => {
      // Head is 1000; the query must stop at 997 so a lagging load-balanced
      // node never sees a toBlock beyond the head it knows about.
      await service.pollEvents(900);

      expect(mockAdapter.queryFilter).toHaveBeenCalledWith('mock-filter', 900, 997);
    });

    it('should make no progress when head-lag window is empty', async () => {
      // fromBlock sits inside the lag window (998..1000): latest is 997, so
      // there is nothing to query and the cursor must not advance past head.
      const result = await service.pollEvents(999);

      expect(result).toEqual({ events: [], newFromBlock: 999 });
      expect(mockAdapter.queryFilter).not.toHaveBeenCalled();
    });

    it('should not advance the cursor or throw when getLogs rejects beyond head', async () => {
      // Load-balanced RPCs reject a range past a lagging node's head with
      // -32602; that tick must make no progress rather than crash-loop.
      mockAdapter.queryFilter.mockRejectedValue(
        new Error('block range extends beyond current head block'),
      );

      const result = await service.pollEvents(900);

      expect(result).toEqual({ events: [], newFromBlock: 900 });
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

    it('should retry on transient failure and succeed', async () => {
      const mockTx = {
        wait: jest.fn().mockResolvedValue({ hash: '0xtxhash' }),
      };
      mockAdapter.confirmExecution
        .mockRejectedValueOnce(new Error('nonce too low'))
        .mockResolvedValueOnce(mockTx);

      const hash = await service.confirmExecution('0xintentid', 'proof-data');

      expect(hash).toBe('0xtxhash');
      expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('should throw after max retries', async () => {
      mockAdapter.confirmExecution.mockRejectedValue(new Error('persistent error'));

      await expect(service.confirmExecution('0xintentid', 'proof-data')).rejects.toThrow(
        'persistent error',
      );

      expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(3);
    }, 10_000);
  });
});
