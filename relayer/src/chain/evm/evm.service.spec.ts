import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EvmService } from './evm.service';
import { ErrorReporter } from '../../observability/error-reporter';
import { EVM_BOOTSTRAP_MAX_ATTEMPTS } from '../../common';

describe('EvmService', () => {
  let service: EvmService;
  let mockProvider: any;
  let mockAdapter: any;
  let mockReporter: { captureException: jest.Mock };

  beforeEach(async () => {
    mockProvider = {
      getBlockNumber: jest.fn().mockResolvedValue(1000),
      // confirmExecution seeds fees from the network and allocates a pending
      // nonce; a mutable counter lets a test observe sequential allocation.
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: 100n,
        maxPriorityFeePerGas: 10n,
      }),
      getTransactionCount: jest.fn().mockResolvedValue(3700),
    };
    mockReporter = { captureException: jest.fn() };

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
        {
          provide: ErrorReporter,
          useValue: mockReporter,
        },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {}, fatal() {} })
      .compile();

    service = module.get<EvmService>(EvmService);
    // Skip onModuleInit, set internal dependencies directly
    (service as any).provider = mockProvider;
    (service as any).adapter = mockAdapter;
    (service as any).wallet = { address: '0x' + '11'.repeat(20) };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('onModuleInit', () => {
    it('pins the provider to the configured chain id so no runtime network discovery happens', () => {
      const values: Record<string, unknown> = {
        EVM_RPC_URL: 'https://rpc.invalid',
        EVM_RELAYER_KEY: '0x' + '11'.repeat(32),
        EVM_ADAPTER_ADDRESS: '0x' + '22'.repeat(20),
      };
      const config = {
        getOrThrow: jest.fn((key: string) => values[key]),
        get: jest.fn((key: string) => (key === 'EVM_CHAIN_ID' ? 11155111 : undefined)),
      };
      const fresh = new EvmService(config as any, mockReporter as any);

      fresh.onModuleInit();

      // With an explicit static network the provider knows its chain id
      // upfront; without it, reading _network before discovery would throw
      // ("network is not available yet") and boot would hit the RPC.
      const provider = (fresh as any).provider;
      expect(provider._network.chainId).toBe(11155111n);
      provider.destroy();
    });
  });

  describe('getBlockNumber', () => {
    it('should return the current block number from provider', async () => {
      const blockNumber = await service.getBlockNumber();

      expect(blockNumber).toBe(1000);
      expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(1);
    });
  });

  describe('bootstrapBlockNumber', () => {
    const transient = () => Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });

    beforeEach(() => {
      // The backoff sleeps are real setTimeout waits in production; skip them
      // so the retry loop runs instantly under test.
      (service as any).sleep = jest.fn().mockResolvedValue(undefined);
    });

    it('retries transient bootstrap failures with backoff, then succeeds', async () => {
      mockProvider.getBlockNumber
        .mockRejectedValueOnce(transient())
        .mockRejectedValueOnce(transient())
        .mockResolvedValueOnce(1000);

      await expect(service.bootstrapBlockNumber()).resolves.toBe(1000);

      expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(3);
      // Exponential backoff between attempts: 1s then 2s.
      expect((service as any).sleep).toHaveBeenNthCalledWith(1, 1000);
      expect((service as any).sleep).toHaveBeenNthCalledWith(2, 2000);
    });

    it('reports each transient failure so Sentry groups them as warnings', async () => {
      mockProvider.getBlockNumber.mockRejectedValueOnce(transient()).mockResolvedValueOnce(1000);

      await service.bootstrapBlockNumber();

      expect(mockReporter.captureException).toHaveBeenCalledTimes(1);
      expect(mockReporter.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'TIMEOUT' }),
      );
    });

    it('throws immediately on a non-transient error', async () => {
      mockProvider.getBlockNumber.mockRejectedValue(new Error('invalid project id'));

      await expect(service.bootstrapBlockNumber()).rejects.toThrow('invalid project id');
      expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect((service as any).sleep).not.toHaveBeenCalled();
    });

    it('gives up after the bounded attempts when the endpoint stays dead', async () => {
      mockProvider.getBlockNumber.mockRejectedValue(transient());

      await expect(service.bootstrapBlockNumber()).rejects.toThrow('request timeout');
      expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(EVM_BOOTSTRAP_MAX_ATTEMPTS);
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
          // M3: IntentSubmitted now carries the committed reference, not the payload.
          blobId: '0x' + 'cd'.repeat(32),
          size: 5n,
          encodingType: 0n,
          storageEpochs: 5n,
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
        blobId: '0x' + 'cd'.repeat(32),
        size: 5,
        encodingType: 0,
        storageEpochs: 5,
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
    const proof = '0x' + '00'.repeat(64);

    /** Build a mined-tx stub whose receipt carries a distinguishable hash. */
    const minedTx = (hash = '0xtxhash') => ({ wait: jest.fn().mockResolvedValue({ hash }) });

    it('should send transaction with an explicit pending nonce and return hash', async () => {
      mockAdapter.confirmExecution.mockResolvedValue(minedTx());

      const hash = await service.confirmExecution('0xintentid', proof);

      expect(hash).toBe('0xtxhash');
      expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(1);
      // The tx is built with the freshly fetched pending nonce, not left to
      // ethers' implicit allocation.
      const overrides = mockAdapter.confirmExecution.mock.calls[0][2];
      expect(overrides.nonce).toBe(3700);
      expect(overrides.maxFeePerGas).toBe(100n);
    });

    it('should retry on transient failure and succeed', async () => {
      mockAdapter.confirmExecution
        .mockRejectedValueOnce(new Error('request timeout'))
        .mockResolvedValueOnce(minedTx());

      const hash = await service.confirmExecution('0xintentid', proof);

      expect(hash).toBe('0xtxhash');
      expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(2);
    }, 10_000);

    it('should throw after max retries', async () => {
      mockAdapter.confirmExecution.mockRejectedValue(new Error('persistent error'));

      await expect(service.confirmExecution('0xintentid', proof)).rejects.toThrow(
        'persistent error',
      );

      expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(3);
    }, 10_000);

    it('rebuilds with a fresh nonce and bumped fees on REPLACEMENT_UNDERPRICED, not a resend', async () => {
      // Attempt 1 collides in the mempool; the retry must NOT resend the same
      // tx (the #364 loop) but rebuild with a refreshed nonce and higher fee.
      mockProvider.getTransactionCount
        .mockResolvedValueOnce(3700) // initial build
        .mockResolvedValueOnce(3701); // refreshed after the conflict
      const conflict = Object.assign(new Error('replacement transaction underpriced'), {
        code: 'REPLACEMENT_UNDERPRICED',
      });
      mockAdapter.confirmExecution.mockRejectedValueOnce(conflict).mockResolvedValueOnce(minedTx());

      const hash = await service.confirmExecution('0xintentid', proof);

      expect(hash).toBe('0xtxhash');
      expect(mockAdapter.confirmExecution).toHaveBeenCalledTimes(2);

      const first = mockAdapter.confirmExecution.mock.calls[0][2];
      const second = mockAdapter.confirmExecution.mock.calls[1][2];
      // Fresh nonce, not the stale one.
      expect(first.nonce).toBe(3700);
      expect(second.nonce).toBe(3701);
      // Fee bumped >= 10% (12% here) so the replacement clears the floor.
      expect(second.maxFeePerGas).toBeGreaterThanOrEqual((first.maxFeePerGas * 110n) / 100n);
      expect(second.maxPriorityFeePerGas).toBeGreaterThanOrEqual(
        (first.maxPriorityFeePerGas * 110n) / 100n,
      );
    });

    it('refreshes the nonce on NONCE_EXPIRED', async () => {
      mockProvider.getTransactionCount.mockResolvedValueOnce(3700).mockResolvedValueOnce(3701);
      const expired = Object.assign(new Error('nonce expired'), { code: 'NONCE_EXPIRED' });
      mockAdapter.confirmExecution.mockRejectedValueOnce(expired).mockResolvedValueOnce(minedTx());

      const hash = await service.confirmExecution('0xintentid', proof);

      expect(hash).toBe('0xtxhash');
      expect(mockProvider.getTransactionCount).toHaveBeenCalledTimes(2);
      expect(mockAdapter.confirmExecution.mock.calls[1][2].nonce).toBe(3701);
    });

    it('serializes concurrent confirm calls so each gets a distinct sequential nonce', async () => {
      // Two return legs fire together (the Promise.allSettled processor tick).
      // Without serialization both would read the same pending nonce and
      // collide; the send queue must hand them out one at a time.
      let next = 3700;
      mockProvider.getTransactionCount.mockImplementation(async () => next++);

      const seenNonces: number[] = [];
      mockAdapter.confirmExecution.mockImplementation(
        async (_id: string, _proof: unknown, overrides: { nonce: number }) => {
          seenNonces.push(overrides.nonce);
          // Yield so a non-serialized implementation would interleave here.
          await new Promise((r) => setTimeout(r, 0));
          return minedTx('0x' + overrides.nonce.toString(16));
        },
      );

      const results = await Promise.all([
        service.confirmExecution('0xa', proof),
        service.confirmExecution('0xb', proof),
        service.confirmExecution('0xc', proof),
      ]);

      expect(results).toHaveLength(3);
      // Distinct and sequential: no two sends shared a nonce.
      expect(seenNonces).toEqual([3700, 3701, 3702]);
      expect(new Set(seenNonces).size).toBe(3);
    });

    it('keeps the wallet usable after a failed send (queue tail advances on rejection)', async () => {
      mockProvider.getTransactionCount.mockResolvedValue(3700);
      mockAdapter.confirmExecution
        .mockRejectedValueOnce(new Error('persistent error'))
        .mockRejectedValueOnce(new Error('persistent error'))
        .mockRejectedValueOnce(new Error('persistent error'))
        .mockResolvedValue(minedTx());

      await expect(service.confirmExecution('0xa', proof)).rejects.toThrow('persistent error');
      // A following send still runs rather than deadlocking on the failed one.
      await expect(service.confirmExecution('0xb', proof)).resolves.toBe('0xtxhash');
    }, 15_000);
  });
});
