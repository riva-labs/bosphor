import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { IntentProcessor } from './intent.processor';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';
import { WalrusService } from '../walrus/walrus.service';

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
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
      }),
    };

    mockWalrus = {
      upload: jest.fn().mockResolvedValue({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      }),
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
    expect(mockSui.executeStore).toHaveBeenCalledWith(intentId, sender, '0xblobobj', deadlineMs);

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
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === 'EVM_DST_EID' ? customEid : undefined)),
            getOrThrow: jest.fn((key: string) => {
              if (key === 'EVM_DST_EID') return customEid;
              throw new Error(`Missing: ${key}`);
            }),
          },
        },
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
    expect(mockSui.quoteLzFee).toHaveBeenCalledWith(intentId, 'blob123', 50, 40161);
    expect(mockSui.lzSendProof).toHaveBeenCalledWith(intentId, 'blob123', 50, 40161, 110_000_000n);
  });

  it('should fall back to default fee when quoteLzFee fails', async () => {
    (mockSui.quoteLzFee as jest.Mock).mockRejectedValue(new Error('devInspect failed'));

    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // lzSendProof should still be called (without fee arg, uses default 0.5 SUI)
    expect(mockSui.lzSendProof).toHaveBeenCalledWith(intentId, 'blob123', 50, 40161);
  });
});

describe('IntentProcessor.handleSuiLzEvent', () => {
  let processor: IntentProcessor;
  let mockSui: Partial<SuiService>;
  let mockWalrus: Partial<WalrusService>;

  // ABI-encode a valid LZ payload: (bytes32 intentId, address sender, bytes payload, uint256 deadline)
  function makeAbiPayload(sender: string, payload: string, deadlineUnix: number): number[] {
    const { ethers } = require('ethers');
    const intentIdBytes32 = '0x' + 'ab'.repeat(32);
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'bytes', 'uint256'],
      [intentIdBytes32, sender, payload, deadlineUnix],
    );
    return Array.from(ethers.getBytes(encoded));
  }

  beforeEach(async () => {
    mockSui = {
      executeStore: jest.fn().mockResolvedValue('suidigest'),
      lzSendProof: jest.fn().mockResolvedValue('lzdigest'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
      getAddress: jest.fn().mockReturnValue('0xsuiaddr'),
      setOnEventCallback: jest.fn(),
      startStreaming: jest.fn(),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
      }),
    };

    mockWalrus = {
      upload: jest.fn().mockResolvedValue({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        {
          provide: EvmService,
          useValue: {
            getBlockNumber: jest.fn().mockResolvedValue(100),
            pollEvents: jest.fn().mockResolvedValue({ events: [], newFromBlock: 101 }),
          },
        },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: mockWalrus },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'EVM_DST_EID') return 40161;
              return undefined;
            }),
            getOrThrow: jest.fn(() => 40161),
          },
        },
      ],
    }).compile();

    processor = module.get<IntentProcessor>(IntentProcessor);
  });

  it('should process a valid Sui LZ event and call lzSendProof', async () => {
    const sender = '0x' + '11'.repeat(20);
    const futureDeadline = Math.floor(Date.now() / 1000) + 3600;
    const payload = makeAbiPayload(sender, '0x' + Buffer.from('hello').toString('hex'), futureDeadline);

    await processor.handleSuiLzEvent({
      intentId: '0x' + 'ab'.repeat(32),
      payload,
      srcEid: 40161,
    });

    expect(mockWalrus.upload).toHaveBeenCalledTimes(1);
    expect(mockSui.lzSendProof).toHaveBeenCalledTimes(1);
  });

  it('should skip already-processed intents (dedup)', async () => {
    const sender = '0x' + '11'.repeat(20);
    const futureDeadline = Math.floor(Date.now() / 1000) + 3600;
    const payload = makeAbiPayload(sender, '0x1234', futureDeadline);
    const event = { intentId: '0x' + 'ab'.repeat(32), payload, srcEid: 40161 };

    await processor.handleSuiLzEvent(event);
    await processor.handleSuiLzEvent(event); // second call

    expect(mockWalrus.upload).toHaveBeenCalledTimes(1); // only once
  });

  it('should mark as processed and return on ABI decode failure', async () => {
    // Silence the expected error log for this test
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    await processor.handleSuiLzEvent({
      intentId: '0x' + 'cc'.repeat(32),
      payload: [0, 1, 2], // invalid ABI
      srcEid: 40161,
    });

    expect(mockWalrus.upload).not.toHaveBeenCalled();

    // Should be deduped on retry
    await processor.handleSuiLzEvent({
      intentId: '0x' + 'cc'.repeat(32),
      payload: [0, 1, 2],
      srcEid: 40161,
    });
  });

  it('should skip expired deadlines', async () => {
    const sender = '0x' + '11'.repeat(20);
    const pastDeadline = Math.floor(Date.now() / 1000) - 3600; // 1h ago
    const payload = makeAbiPayload(sender, '0x1234', pastDeadline);

    await processor.handleSuiLzEvent({
      intentId: '0x' + 'dd'.repeat(32),
      payload,
      srcEid: 40161,
    });

    expect(mockWalrus.upload).not.toHaveBeenCalled();
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
        {
          provide: ConfigService,
          useValue: { get: jest.fn(() => 40161), getOrThrow: jest.fn(() => 40161) },
        },
      ],
    }).compile();

    processor = module.get<IntentProcessor>(IntentProcessor);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should poll EVM events when called', async () => {
    await processor.poll();

    // Sui events are now pushed via checkpoint streaming, only EVM is polled
    expect(mockEvm.pollEvents).toHaveBeenCalled();
  });

  it('should not poll when stopped', async () => {
    await processor.onModuleDestroy();
    await processor.poll();

    expect(mockEvm.pollEvents).not.toHaveBeenCalled();
  });

  it('should skip poll if already processing', async () => {
    // Make the first poll hang on EVM
    (mockEvm.pollEvents as jest.Mock).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ events: [], newFromBlock: 101 }), 200),
        ),
    );

    const first = processor.poll();
    await processor.poll();

    expect(mockEvm.pollEvents).toHaveBeenCalledTimes(1);

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
    };
    Object.assign(mockSui, {
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
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
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'INTENT_TTL_MS') return 60_000; // 1 minute TTL for test
              if (key === 'EVM_DST_EID') return 40161;
              return undefined;
            }),
            getOrThrow: jest.fn(() => 40161),
          },
        },
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
    };
    Object.assign(mockSui, {
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
      }),
    });

    // Config WITHOUT INTENT_TTL_MS (should default to 1h)
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        {
          provide: EvmService,
          useValue: {
            ...mockEvm,
            pollEvents: jest.fn().mockResolvedValue({ events: [evmEvent], newFromBlock: 101 }),
          },
        },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: fullWalrus },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'EVM_DST_EID') return 40161;
              return undefined; // no INTENT_TTL_MS
            }),
            getOrThrow: jest.fn(() => 40161),
          },
        },
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
