import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { IntentProcessor } from './intent.processor';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';
import { SuiCheckpointService } from '../chain/sui/sui-checkpoint.service';
import { SuiLzService } from '../chain/sui/sui-lz.service';
import { WalrusService } from '../walrus/walrus.service';
import { MetricsService } from '../metrics/metrics.service';

function makeMetricsMock() {
  return {
    recordIntentProcessed: jest.fn(),
    recordLzSend: jest.fn(),
    observeWalrusUpload: jest.fn(),
    setCheckpointCursorLag: jest.fn(),
  };
}

describe('IntentProcessor.processIntent', () => {
  let processor: IntentProcessor;
  let mockEvm: Partial<EvmService>;
  let mockSui: Partial<SuiService>;
  let mockSuiCheckpoint: Partial<SuiCheckpointService>;
  let mockSuiLz: Partial<SuiLzService>;
  let mockWalrus: Partial<WalrusService>;
  let mockConfig: Partial<ConfigService>;
  let mockMetrics: jest.Mocked<Pick<MetricsService, 'recordIntentProcessed' | 'recordLzSend' | 'observeWalrusUpload' | 'setCheckpointCursorLag'>>;

  beforeEach(async () => {
    mockEvm = {
      getBlockNumber: jest.fn().mockResolvedValue(100),
      pollEvents: jest.fn().mockResolvedValue({ events: [], newFromBlock: 101 }),
      confirmExecution: jest.fn().mockResolvedValue('0xevmhash'),
    };

    mockSui = {
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
      }),
    };

    mockSuiCheckpoint = {
      setOnEventCallback: jest.fn(),
      startStreaming: jest.fn(),
      stop: jest.fn(),
    };

    mockSuiLz = {
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest456'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
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

    mockMetrics = {
      recordIntentProcessed: jest.fn(),
      recordLzSend: jest.fn(),
      observeWalrusUpload: jest.fn(),
      setCheckpointCursorLag: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: SuiCheckpointService, useValue: mockSuiCheckpoint },
        { provide: SuiLzService, useValue: mockSuiLz },
        { provide: WalrusService, useValue: mockWalrus },
        { provide: ConfigService, useValue: mockConfig },
        { provide: MetricsService, useValue: mockMetrics },
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
    expect(mockSuiLz.lzSendProof).toHaveBeenCalledWith(
      intentId,
      'blob123',
      50,
      40161,
      110_000_000n, // 100M quoted + 10% buffer
    );

    // confirmExecution should NOT be called
    expect(mockEvm.confirmExecution).not.toHaveBeenCalled();
  });

  it('records Walrus upload timing and a successful LZ send for a fulfilled intent', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    expect(mockMetrics.observeWalrusUpload).toHaveBeenCalledTimes(1);
    expect(mockMetrics.observeWalrusUpload.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
    expect(mockMetrics.recordLzSend).toHaveBeenCalledWith('success');
  });

  it('should use EVM_DST_EID from config for lzSendProof', async () => {
    const customEid = 30101; // mainnet EID

    const customModule: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        { provide: SuiCheckpointService, useValue: mockSuiCheckpoint },
        { provide: SuiLzService, useValue: mockSuiLz },
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
        { provide: MetricsService, useValue: mockMetrics },
      ],
    }).compile();

    const customProcessor = customModule.get<IntentProcessor>(IntentProcessor);

    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (customProcessor as any).processIntent(intentId, sender, payload, deadlineMs);

    expect(mockSuiLz.lzSendProof).toHaveBeenCalledWith(
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
    const proofOrder = (mockSuiLz.lzSendProof as jest.Mock).mock.invocationCallOrder[0];

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
    expect(mockSuiLz.quoteLzFee).toHaveBeenCalledWith(intentId, 'blob123', 50, 40161);
    expect(mockSuiLz.lzSendProof).toHaveBeenCalledWith(intentId, 'blob123', 50, 40161, 110_000_000n);
  });

  it('should fall back to default fee when quoteLzFee fails', async () => {
    (mockSuiLz.quoteLzFee as jest.Mock).mockRejectedValue(new Error('devInspect failed'));

    const intentId = '0x' + 'ab'.repeat(32);
    const sender = '0x' + '11'.repeat(20);
    const payload = Buffer.from('hello');
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(intentId, sender, payload, deadlineMs);

    // lzSendProof should still be called (without fee arg, uses default 0.5 SUI)
    expect(mockSuiLz.lzSendProof).toHaveBeenCalledWith(intentId, 'blob123', 50, 40161);
  });
});

describe('IntentProcessor.handleSuiLzEvent', () => {
  let processor: IntentProcessor;
  let mockSui: Partial<SuiService>;
  let mockSuiCheckpoint: Partial<SuiCheckpointService>;
  let mockSuiLz: Partial<SuiLzService>;
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
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
      getAddress: jest.fn().mockReturnValue('0xsuiaddr'),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
      }),
    };

    mockSuiCheckpoint = {
      setOnEventCallback: jest.fn(),
      startStreaming: jest.fn(),
      stop: jest.fn(),
    };

    mockSuiLz = {
      lzSendProof: jest.fn().mockResolvedValue('lzdigest'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
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
        { provide: SuiCheckpointService, useValue: mockSuiCheckpoint },
        { provide: SuiLzService, useValue: mockSuiLz },
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
        { provide: MetricsService, useValue: makeMetricsMock() },
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
    expect(mockSuiLz.lzSendProof).toHaveBeenCalledTimes(1);
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
  let mockSui: Partial<SuiService>;
  let mockSuiCheckpoint: Partial<SuiCheckpointService>;
  let mockSuiLz: Partial<SuiLzService>;
  let mockWalrus: Partial<WalrusService>;

  function abiPayload(sender: string, payload: string, deadlineUnix: number): number[] {
    const encoded = require('ethers').AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'bytes', 'uint256'],
      ['0x' + 'ab'.repeat(32), sender, payload, deadlineUnix],
    );
    return Array.from(require('ethers').getBytes(encoded));
  }

  async function build(ttlMs?: number) {
    mockSuiCheckpoint = { setOnEventCallback: jest.fn(), startStreaming: jest.fn(), stop: jest.fn() };
    mockWalrus = {
      upload: jest.fn().mockResolvedValue({ blobId: 'blob123', suiObjectId: '0xblobobj', endEpoch: 50 }),
    };
    mockSui = {
      getAddress: jest.fn().mockReturnValue('0xsuiaddr'),
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
      }),
    };
    mockSuiLz = {
      lzSendProof: jest.fn().mockResolvedValue('lzproofdigest'),
      quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: { getBlockNumber: jest.fn().mockResolvedValue(100) } },
        { provide: SuiService, useValue: mockSui },
        { provide: SuiCheckpointService, useValue: mockSuiCheckpoint },
        { provide: SuiLzService, useValue: mockSuiLz },
        { provide: WalrusService, useValue: mockWalrus },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'INTENT_TTL_MS') return ttlMs;
              if (key === 'EVM_DST_EID') return 40161;
              return undefined;
            }),
            getOrThrow: jest.fn(() => 40161),
          },
        },
        { provide: MetricsService, useValue: makeMetricsMock() },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {}, fatal() {} })
      .compile();

    return module.get<IntentProcessor>(IntentProcessor);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('is a no-op when stopped (no EVM polling drives fulfillment)', async () => {
    processor = await build(60_000);
    await processor.onModuleDestroy();
    expect(() => processor.poll()).not.toThrow();
  });

  it('prunes expired intents so a Sui LZ intent is re-processable after its TTL', async () => {
    processor = await build(60_000); // 1 minute TTL

    const sender = '0x' + '11'.repeat(20);
    const deadline = Math.floor(Date.now() / 1000) + 7200;
    const event = {
      intentId: '0x' + 'cc'.repeat(32),
      payload: abiPayload(sender, '0x' + Buffer.from('hello').toString('hex'), deadline),
      srcEid: 40161,
    };

    const baseTime = Date.now();
    const dateSpy = jest.spyOn(Date, 'now');

    // t=0: processed via the Sui LZ path
    dateSpy.mockReturnValue(baseTime);
    await processor.handleSuiLzEvent(event);
    expect(mockWalrus.upload).toHaveBeenCalledTimes(1);

    // t=30s (within TTL): deduped
    dateSpy.mockReturnValue(baseTime + 30_000);
    await processor.handleSuiLzEvent(event);
    expect(mockWalrus.upload).toHaveBeenCalledTimes(1);

    // t=61s (past TTL): poll prunes, then it can be re-processed
    dateSpy.mockReturnValue(baseTime + 61_000);
    processor.poll();
    await processor.handleSuiLzEvent(event);
    expect(mockWalrus.upload).toHaveBeenCalledTimes(2);
  });
});
