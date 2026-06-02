import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as fs from 'node:fs';
import { IntentProcessor } from './intent.processor';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';
import { WalrusService } from '../walrus/walrus.service';

jest.mock('node:fs');

describe('IntentProcessor.processIntent', () => {
  let processor: IntentProcessor;
  let mockEvm: Partial<EvmService>;
  let mockSui: Partial<SuiService>;
  let mockWalrus: Partial<WalrusService>;
  let mockConfig: Partial<ConfigService>;

  beforeEach(async () => {
    mockEvm = {
      getBlockNumber: jest.fn().mockResolvedValue(100),
      pollEvents: jest.fn().mockResolvedValue({ events: [], newFromBlock: 101 }),
      confirmExecution: jest.fn().mockResolvedValue('0xevmhash'),
    };

    mockSui = {
      pollLzEvents: jest.fn().mockResolvedValue({
        events: [],
        newCursor: null,
        hasMore: false,
      }),
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
      getClient: jest.fn().mockReturnValue({
        waitForTransaction: jest.fn().mockResolvedValue({}),
      }),
    };

    mockWalrus = {
      upload: jest.fn().mockResolvedValue({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      }),
      getAggregatorUrl: jest.fn().mockReturnValue('https://aggregator.test'),
      findBlobObject: jest.fn().mockResolvedValue('0xblobobj'),
    };

    mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'EVM_DST_EID') return 40161;
        return undefined;
      }),
      getOrThrow: jest.fn((key: string) => {
        if (key === 'EVM_DST_EID') return 40161;
        throw new Error(`Missing config: ${key}`);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: mockWalrus },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();

    processor = module.get<IntentProcessor>(IntentProcessor);
  });

  it('should call lzSendProof instead of confirmExecution after Walrus upload and executeStore', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    // processIntent is private, so we access it via the class prototype
    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // Walrus upload should be called
    expect(mockWalrus.upload).toHaveBeenCalledWith(payload);

    // executeStore should be called
    expect(mockSui.executeStore).toHaveBeenCalledWith(
      intentId,
      sender,
      '0xblobobj',
      deadlineMs,
    );

    // lzSendProof should be called with Walrus results, configured dstEid, and quoted fee
    expect(mockSui.lzSendProof).toHaveBeenCalledWith(
      intentId,
      'blob123',
      50,
      40161,
      110_000_000n, // 100M quoted + 10% buffer
    );

    // confirmExecution should NOT be called
    expect(mockEvm.confirmExecution).not.toHaveBeenCalled();
  });

  it('should use EVM_DST_EID from config for lzSendProof', async () => {
    const customEid = 30101; // mainnet EID

    const customModule: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: mockWalrus },
        { provide: ConfigService, useValue: { get: jest.fn((key: string) => key === 'EVM_DST_EID' ? customEid : undefined), getOrThrow: jest.fn((key: string) => { if (key === 'EVM_DST_EID') return customEid; throw new Error(`Missing: ${key}`); }) } },
      ],
    }).compile();

    const customProcessor = customModule.get<IntentProcessor>(IntentProcessor);

    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (customProcessor as any).processIntent(intentId, sender, payload, deadlineMs);

    expect(mockSui.lzSendProof).toHaveBeenCalledWith(
      intentId,
      'blob123',
      50,
      customEid,
      110_000_000n,
    );
  });

  it('should not call confirmExecution at all', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    expect(mockEvm.confirmExecution).not.toHaveBeenCalled();
  });

  it('should still upload to Walrus and executeStore before sending proof', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('test');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // Verify call order: upload first, then executeStore, then lzSendProof
    const uploadOrder = (mockWalrus.upload as jest.Mock).mock.invocationCallOrder[0];
    const storeOrder = (mockSui.executeStore as jest.Mock).mock.invocationCallOrder[0];
    const proofOrder = (mockSui.lzSendProof as jest.Mock).mock.invocationCallOrder[0];

    expect(uploadOrder).toBeLessThan(storeOrder);
    expect(storeOrder).toBeLessThan(proofOrder);
  });

  it('should pass quoted fee with 10% buffer to lzSendProof', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // quoteLzFee returns 100_000_000n, 10% buffer = 110_000_000n
    expect(mockSui.quoteLzFee).toHaveBeenCalledWith(
      intentId,
      'blob123',
      50,
      40161,
    );
    expect(mockSui.lzSendProof).toHaveBeenCalledWith(
      intentId,
      'blob123',
      50,
      40161,
      110_000_000n,
    );
  });

  it('should skip lzSendProof when executeStore is already done AND proof was already sent', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    // Simulate executeStore abort code 2 (already done)
    (mockSui.executeStore as jest.Mock).mockRejectedValue(
      new Error('MoveAbort(_, 2) in function execute_store'),
    );

    // Pre-populate sentProofs to simulate a prior successful run
    (processor as any).sentProofs.add(intentId);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // Walrus upload should still be called
    expect(mockWalrus.upload).toHaveBeenCalled();

    // lzSendProof should NOT be called (dedup guard)
    expect(mockSui.lzSendProof).not.toHaveBeenCalled();
    expect(mockSui.quoteLzFee).not.toHaveBeenCalled();
  });

  it('should proceed with lzSendProof when executeStore is already done BUT proof was NOT sent', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    // Simulate executeStore abort code 2 (already done)
    (mockSui.executeStore as jest.Mock).mockRejectedValue(
      new Error('MoveAbort(_, 2) in function execute_store'),
    );

    // sentProofs is empty (no prior record of sending proof)

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // lzSendProof SHOULD be called (edge case: store done but proof not sent)
    expect(mockSui.lzSendProof).toHaveBeenCalled();

    // Intent should now be in sentProofs
    expect((processor as any).sentProofs.has(intentId)).toBe(true);
  });

  it('should persist sentProofs to file after successful lzSendProof', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // sentProofs file should be written
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'sui-sent-proofs.json',
      expect.stringContaining(intentId),
      'utf-8',
    );
  });

  it('should fall back to default fee when quoteLzFee fails', async () => {
    (mockSui.quoteLzFee as jest.Mock).mockRejectedValue(new Error('devInspect failed'));

    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // lzSendProof should still be called (without fee arg, uses default 0.5 SUI)
    expect(mockSui.lzSendProof).toHaveBeenCalledWith(
      intentId,
      'blob123',
      50,
      40161,
    );
  });
});

describe('IntentProcessor.poll', () => {
  let processor: IntentProcessor;
  let mockEvm: Partial<EvmService>;
  let mockSui: Partial<SuiService>;
  let mockWalrus: Partial<WalrusService>;

  beforeEach(async () => {
    mockEvm = {
      getBlockNumber: jest.fn().mockResolvedValue(100),
      pollEvents: jest.fn().mockResolvedValue({ events: [], newFromBlock: 101 }),
    };

    mockSui = {
      pollLzEvents: jest.fn().mockResolvedValue({
        events: [],
        newCursor: null,
        hasMore: false,
      }),
      getAddress: jest.fn().mockReturnValue('0xsuiaddr'),
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
    };

    mockWalrus = {};

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: mockWalrus },
        { provide: ConfigService, useValue: { get: jest.fn(() => 40161), getOrThrow: jest.fn(() => 40161) } },
      ],
    }).compile();

    processor = module.get<IntentProcessor>(IntentProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should poll Sui and EVM events when called', async () => {
    await processor.poll();

    expect(mockSui.pollLzEvents).toHaveBeenCalled();
    expect(mockEvm.pollEvents).toHaveBeenCalled();
  });

  it('should not poll when stopped', async () => {
    // Trigger shutdown
    await processor.onModuleDestroy();

    await processor.poll();

    expect(mockSui.pollLzEvents).not.toHaveBeenCalled();
    expect(mockEvm.pollEvents).not.toHaveBeenCalled();
  });

  it('should skip poll if already processing', async () => {
    // Make the first poll hang
    (mockSui.pollLzEvents as jest.Mock).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ events: [], newCursor: null, hasMore: false }), 200)),
    );

    // Start first poll (will be in-flight)
    const first = processor.poll();

    // Second poll should be skipped since first is still processing
    await processor.poll();

    // Only one call to pollLzEvents
    expect(mockSui.pollLzEvents).toHaveBeenCalledTimes(1);

    await first;
  });

  it('should re-process an intent after TTL expires', async () => {
    const intentId = '0x' + 'cc'.repeat(32);
    const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200); // 2h from now

    const evmEvent = {
      intentId,
      sender: '0x' + '11'.repeat(20),
      targetChainId: 1n,
      payload: '0x' + Buffer.from('hello').toString('hex'),
      nonce: 1n,
      deadline: futureDeadline,
    };

    // Extend mocks to support full processing
    mockWalrus = {
      upload: jest.fn().mockResolvedValue({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      }),
      getAggregatorUrl: jest.fn().mockReturnValue('https://aggregator.test'),
      findBlobObject: jest.fn().mockResolvedValue('0xblobobj'),
    };
    Object.assign(mockSui, {
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getClient: jest.fn().mockReturnValue({
        waitForTransaction: jest.fn().mockResolvedValue({}),
      }),
    });

    // Return the event on every EVM poll
    (mockEvm.pollEvents as jest.Mock).mockResolvedValue({
      events: [evmEvent],
      newFromBlock: 101,
    });

    // Rebuild processor with full mocks
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: mockWalrus },
        { provide: ConfigService, useValue: {
          get: jest.fn((key: string) => {
            if (key === 'INTENT_TTL_MS') return 60_000; // 1 minute TTL for test
            if (key === 'EVM_DST_EID') return 40161;
            return undefined;
          }),
          getOrThrow: jest.fn(() => 40161),
        }},
      ],
    }).compile();

    processor = module.get<IntentProcessor>(IntentProcessor);

    const baseTime = Date.now();
    const dateSpy = jest.spyOn(Date, 'now');

    // First poll at t=0: intent should be processed
    dateSpy.mockReturnValue(baseTime);
    await processor.poll();
    expect(mockWalrus.upload).toHaveBeenCalledTimes(1);

    // Second poll at t=30s (within TTL): intent should be deduped
    dateSpy.mockReturnValue(baseTime + 30_000);
    await processor.poll();
    expect(mockWalrus.upload).toHaveBeenCalledTimes(1); // still 1

    // Third poll at t=61s (past TTL): intent should be re-processable
    dateSpy.mockReturnValue(baseTime + 61_000);
    await processor.poll();
    expect(mockWalrus.upload).toHaveBeenCalledTimes(2); // now 2
  });

  it('should save cursor to file after processing Sui events', async () => {
    const intentId = '0x' + 'ee'.repeat(32);
    const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 7200);

    const suiEvent = {
      intentId,
      payload: Array.from(
        Buffer.from(
          new (await import('ethers')).AbiCoder()
            .encode(
              ['bytes32', 'address', 'bytes', 'uint256'],
              [intentId, '0x' + '11'.repeat(20), '0x1234', futureDeadline],
            )
            .slice(2),
          'hex',
        ),
      ),
      srcEid: 40161,
      nonce: 1n,
    };

    const savedCursor = { txDigest: 'abc123', eventSeq: '0' };

    // Full mocks for processing
    const fullSui = {
      ...mockSui,
      pollLzEvents: jest.fn().mockResolvedValue({
        events: [suiEvent],
        newCursor: savedCursor,
        hasMore: false,
      }),
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getClient: jest.fn().mockReturnValue({
        waitForTransaction: jest.fn().mockResolvedValue({}),
      }),
    };
    const fullWalrus = {
      upload: jest.fn().mockResolvedValue({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      }),
      getAggregatorUrl: jest.fn().mockReturnValue('https://aggregator.test'),
    };

    const cursorConfig = {
      get: jest.fn((key: string) => {
        if (key === 'EVM_DST_EID') return 40161;
        return undefined;
      }),
      getOrThrow: jest.fn(() => 40161),
    };

    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: fullSui },
        { provide: WalrusService, useValue: fullWalrus },
        { provide: ConfigService, useValue: cursorConfig },
      ],
    }).compile();

    const proc = module2.get<IntentProcessor>(IntentProcessor);
    await proc.poll();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      'sui-cursor.json',
      JSON.stringify(savedCursor),
      'utf-8',
    );
  });

  it('should load cursor from file on init', async () => {
    const savedCursor = { txDigest: 'saved123', eventSeq: '5' };
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(
      JSON.stringify(savedCursor),
    );

    const cursorConfig = {
      get: jest.fn((key: string) => {
        if (key === 'EVM_DST_EID') return 40161;
        return undefined;
      }),
      getOrThrow: jest.fn(() => 40161),
    };

    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: mockWalrus },
        { provide: ConfigService, useValue: cursorConfig },
      ],
    }).compile();

    const proc = module2.get<IntentProcessor>(IntentProcessor);
    await proc.onModuleInit();

    // After init, poll should use the loaded cursor
    await proc.poll();
    expect(mockSui.pollLzEvents).toHaveBeenCalledWith(savedCursor);
  });

  it('should default to 1 hour TTL when INTENT_TTL_MS is not configured', async () => {
    const intentId = '0x' + 'dd'.repeat(32);
    const futureDeadline = BigInt(Math.floor(Date.now() / 1000) + 14400); // 4h from now

    const evmEvent = {
      intentId,
      sender: '0x' + '11'.repeat(20),
      targetChainId: 1n,
      payload: '0x' + Buffer.from('hello').toString('hex'),
      nonce: 1n,
      deadline: futureDeadline,
    };

    // Full mocks for processing
    const fullWalrus = {
      upload: jest.fn().mockResolvedValue({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      }),
      getAggregatorUrl: jest.fn().mockReturnValue('https://aggregator.test'),
      findBlobObject: jest.fn().mockResolvedValue('0xblobobj'),
    };
    Object.assign(mockSui, {
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getClient: jest.fn().mockReturnValue({
        waitForTransaction: jest.fn().mockResolvedValue({}),
      }),
    });

    // Config WITHOUT INTENT_TTL_MS (should default to 1h)
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: { ...mockEvm, pollEvents: jest.fn().mockResolvedValue({ events: [evmEvent], newFromBlock: 101 }) } },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: fullWalrus },
        { provide: ConfigService, useValue: {
          get: jest.fn((key: string) => {
            if (key === 'EVM_DST_EID') return 40161;
            return undefined; // no INTENT_TTL_MS
          }),
          getOrThrow: jest.fn(() => 40161),
        }},
      ],
    }).compile();

    const proc = module.get<IntentProcessor>(IntentProcessor);
    const baseTime = Date.now();
    const dateSpy = jest.spyOn(Date, 'now');

    // First poll: processes the intent
    dateSpy.mockReturnValue(baseTime);
    await proc.poll();
    expect(fullWalrus.upload).toHaveBeenCalledTimes(1);

    // Poll at t=59min: still deduped (within default 1h TTL)
    dateSpy.mockReturnValue(baseTime + 59 * 60_000);
    await proc.poll();
    expect(fullWalrus.upload).toHaveBeenCalledTimes(1);

    // Poll at t=61min: re-processed (past default 1h TTL)
    dateSpy.mockReturnValue(baseTime + 61 * 60_000);
    await proc.poll();
    expect(fullWalrus.upload).toHaveBeenCalledTimes(2);
  });
});
