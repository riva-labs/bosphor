import { Test, TestingModule } from '@nestjs/testing';
import { IntentProcessor } from './intent.processor';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';
import { WalrusService } from '../walrus/walrus.service';

describe('IntentProcessor.processIntent', () => {
  let processor: IntentProcessor;
  let mockEvm: Partial<EvmService>;
  let mockSui: Partial<SuiService>;
  let mockWalrus: Partial<WalrusService>;

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: WalrusService, useValue: mockWalrus },
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

    // lzSendProof should be called with Walrus results
    expect(mockSui.lzSendProof).toHaveBeenCalledWith(
      intentId,
      'blob123',
      50,
      expect.any(Number), // dstEid
    );

    // confirmExecution should NOT be called
    expect(mockEvm.confirmExecution).not.toHaveBeenCalled();
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
      ],
    }).compile();

    processor = module.get<IntentProcessor>(IntentProcessor);
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
});
