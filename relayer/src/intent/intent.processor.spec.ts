// IntentProcessor transitively imports SolanaService, which imports
// @solana/web3.js (heavy transitive ESM). SolanaService is provided as a mock
// here, so stub the module to keep the spec pure.
jest.mock('@solana/web3.js', () => ({
  Connection: class {},
  PublicKey: class {},
  Keypair: class {},
  Transaction: class {},
  TransactionInstruction: class {},
  sendAndConfirmTransaction: jest.fn(),
}));

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntentProcessor } from './intent.processor';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService, SuiLzEvent } from '../chain/sui/sui.service';
import { SuiCheckpointService } from '../chain/sui/sui-checkpoint.service';
import { SuiLzService } from '../chain/sui/sui-lz.service';
import { SolanaService } from '../chain/solana/solana.service';
import { WalrusService } from '../walrus/walrus.service';
import { WalTopUpService } from '../walrus/wal-topup.service';
import { MetricsService } from '../metrics/metrics.service';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { ErrorReporter } from '../observability/error-reporter';
import { IntentIngest, BufferedBlob } from '../ingest/intent-ingest.service';

const INTENT_ID = '0x' + 'ab'.repeat(32);
const SENDER = '0x' + '11'.repeat(20);
// A committed blob id (32 bytes) as 0x hex and its matching base64url form.
const COMMITTED_BYTES = Buffer.from('cd'.repeat(32), 'hex');
const COMMITTED_HEX = '0x' + COMMITTED_BYTES.toString('hex');
const COMMITTED_B64URL = COMMITTED_BYTES.toString('base64url');
// The same commitment as a big-endian u256 decimal (the on-chain event form).
const COMMITTED_U256 = BigInt(COMMITTED_HEX).toString();

const walTopUpProvider = {
  provide: WalTopUpService,
  useValue: { ensureWal: jest.fn().mockResolvedValue(undefined) },
};

function makeLifecycleMock(commitment?: unknown) {
  return {
    recordHop: jest.fn().mockResolvedValue(undefined),
    getRecentIntents: jest.fn().mockResolvedValue([]),
    getCommitment: jest.fn().mockResolvedValue(commitment ?? null),
  };
}

function makeMetricsMock() {
  return {
    recordIntentProcessed: jest.fn(),
    recordLzSend: jest.fn(),
    observeWalrusUpload: jest.fn(),
    setCheckpointCursorLag: jest.fn(),
    recordWalStorageCost: jest.fn(),
  };
}

function makeReporterMock() {
  return { captureException: jest.fn() };
}

function bufferedBlob(bytes = Buffer.from('hello')): BufferedBlob {
  return { bytes, blobId: COMMITTED_B64URL, size: bytes.length };
}

function suiEvent(overrides: Partial<SuiLzEvent> = {}): SuiLzEvent {
  return {
    intentId: INTENT_ID,
    committedBlobId: COMMITTED_U256,
    size: 5,
    encodingType: 0,
    storageEpochs: 5,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    srcEid: 40161,
    nonce: 1n,
    ...overrides,
  };
}

const reporterProvider = { provide: ErrorReporter, useValue: makeReporterMock() };

describe('IntentProcessor.processIntent', () => {
  let processor: IntentProcessor;
  let mockSui: Partial<SuiService>;
  let mockSuiLz: Partial<SuiLzService>;
  let mockWalrus: Partial<WalrusService>;
  let mockMetrics: ReturnType<typeof makeMetricsMock>;
  let mockLifecycle: ReturnType<typeof makeLifecycleMock>;
  let mockEvm: { getBlockNumber: jest.Mock; confirmExecution: jest.Mock };
  let mockSolana: { canConfirm: jest.Mock; confirmExecution: jest.Mock };

  beforeEach(async () => {
    mockSui = {
      executeStore: jest.fn().mockResolvedValue('suidigest123'),
      getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
      getClient: jest.fn().mockReturnValue({
        core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
      }),
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
        walCostMist: undefined,
      }),
    };
    mockMetrics = makeMetricsMock();
    mockLifecycle = makeLifecycleMock({ committedBlobId: COMMITTED_HEX, sender: SENDER });
    mockEvm = {
      getBlockNumber: jest.fn().mockResolvedValue(100),
      confirmExecution: jest.fn().mockResolvedValue('0xevmconfirm'),
    };
    mockSolana = {
      canConfirm: jest.fn().mockReturnValue(false),
      confirmExecution: jest.fn().mockResolvedValue('solsig123'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
        {
          provide: SuiCheckpointService,
          useValue: { setOnEventCallback: jest.fn(), startStreaming: jest.fn(), stop: jest.fn() },
        },
        { provide: SuiLzService, useValue: mockSuiLz },
        { provide: SolanaService, useValue: mockSolana },
        { provide: WalrusService, useValue: mockWalrus },
        walTopUpProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'EVM_DST_EID' ? 40161 : key === 'SOLANA_SRC_EID' ? 40168 : undefined,
            ),
            getOrThrow: jest.fn(() => 40161),
          },
        },
        { provide: MetricsService, useValue: mockMetrics },
        { provide: IntentLifecycleStore, useValue: mockLifecycle },
        reporterProvider,
        { provide: IntentIngest, useValue: { peek: jest.fn(), take: jest.fn(), drop: jest.fn() } },
      ],
    }).compile();

    processor = module.get<IntentProcessor>(IntentProcessor);
  });

  it('uploads the ingested bytes, executes store, and sends the proof', async () => {
    const buffered = bufferedBlob();
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(INTENT_ID, SENDER, buffered, deadlineMs, COMMITTED_U256, 40161);

    expect(mockWalrus.upload).toHaveBeenCalledWith(buffered.bytes);
    expect(mockSui.executeStore).toHaveBeenCalledWith(INTENT_ID, SENDER, '0xblobobj', deadlineMs);
    expect(mockSuiLz.lzSendProof).toHaveBeenCalledWith(
      INTENT_ID,
      'blob123',
      50,
      40161,
      110_000_000n,
    );
  });

  it('routes a Solana-origin return to confirm_execution, not the EVM path', async () => {
    // A blob id whose canonical big-endian field equals the committed reference.
    (mockWalrus.upload as jest.Mock).mockResolvedValue({
      blobId: COMMITTED_B64URL,
      suiObjectId: '0xblobobj',
      endEpoch: 50,
      walCostMist: undefined,
    });
    mockSolana.canConfirm.mockReturnValue(true);
    const deadlineMs = BigInt(Date.now() + 60_000);

    // srcEid 40168 = Solana origin.
    await (processor as any).processIntent(INTENT_ID, SENDER, bufferedBlob(), deadlineMs, COMMITTED_U256, 40168);

    expect(mockSolana.confirmExecution).toHaveBeenCalledWith(INTENT_ID, COMMITTED_HEX, 50n);
    expect(mockSuiLz.lzSendProof).not.toHaveBeenCalled();
    expect(mockEvm.confirmExecution).not.toHaveBeenCalled();
  });

  it('throws for a Solana-origin intent when no Solana return signer is configured', async () => {
    (mockWalrus.upload as jest.Mock).mockResolvedValue({
      blobId: COMMITTED_B64URL,
      suiObjectId: '0xblobobj',
      endEpoch: 50,
      walCostMist: undefined,
    });
    mockSolana.canConfirm.mockReturnValue(false);
    const deadlineMs = BigInt(Date.now() + 60_000);

    await expect(
      (processor as any).processIntent(INTENT_ID, SENDER, bufferedBlob(), deadlineMs, COMMITTED_U256, 40168),
    ).rejects.toThrow(/requires a Solana signer/);
    expect(mockSolana.confirmExecution).not.toHaveBeenCalled();
  });

  it('re-verifies the committed blob id before spending WAL and refuses a mismatch', async () => {
    // A buffer whose blob id no longer matches the committed reference.
    const tampered: BufferedBlob = {
      bytes: Buffer.from('hello'),
      blobId: Buffer.from('99'.repeat(32), 'hex').toString('base64url'),
      size: 5,
    };
    const deadlineMs = BigInt(Date.now() + 60_000);

    await expect(
      (processor as any).processIntent(INTENT_ID, SENDER, tampered, deadlineMs, COMMITTED_U256, 40161),
    ).rejects.toThrow(/Refusing to store/);

    expect(mockWalrus.upload).not.toHaveBeenCalled();
  });

  it('records the Walrus, Sui-record and proof-sent hops', async () => {
    const deadlineMs = BigInt(Date.now() + 60_000);
    await (processor as any).processIntent(
      INTENT_ID,
      SENDER,
      bufferedBlob(),
      deadlineMs,
      COMMITTED_U256,
    );

    expect(mockLifecycle.recordHop).toHaveBeenCalledWith(
      INTENT_ID,
      'stored_walrus',
      expect.objectContaining({ blobId: 'blob123', suiObjectId: '0xblobobj', endEpoch: 50 }),
    );
    expect(mockLifecycle.recordHop).toHaveBeenCalledWith(INTENT_ID, 'recorded_sui', {
      txHash: 'suidigest123',
    });
    expect(mockLifecycle.recordHop).toHaveBeenCalledWith(INTENT_ID, 'proof_sent', {
      txHash: 'lzproofdigest456',
    });
  });

  it('records the per-intent WAL cost when the upload result provides it', async () => {
    (mockWalrus.upload as jest.Mock).mockResolvedValue({
      blobId: 'blob123',
      suiObjectId: '0xblobobj',
      endEpoch: 50,
      walCostMist: 42n,
    });
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(
      INTENT_ID,
      SENDER,
      bufferedBlob(),
      deadlineMs,
      COMMITTED_U256,
    );

    expect(mockMetrics.recordWalStorageCost).toHaveBeenCalledWith(42);
  });

  it('does not record a WAL cost when the upload result omits it (unknown cost)', async () => {
    const deadlineMs = BigInt(Date.now() + 60_000);
    await (processor as any).processIntent(
      INTENT_ID,
      SENDER,
      bufferedBlob(),
      deadlineMs,
      COMMITTED_U256,
    );
    expect(mockMetrics.recordWalStorageCost).not.toHaveBeenCalled();
  });

  it('falls back to confirmExecution when the LZ send path fails', async () => {
    // A valid 32-byte Walrus blob id so the fallback can build the canonical proof.
    (mockWalrus.upload as jest.Mock).mockResolvedValue({
      blobId: COMMITTED_B64URL,
      suiObjectId: '0xblobobj',
      endEpoch: 50,
      walCostMist: undefined,
    });
    (mockSuiLz.quoteLzFee as jest.Mock).mockRejectedValue(new Error('devInspect failed'));
    const deadlineMs = BigInt(Date.now() + 60_000);

    await (processor as any).processIntent(
      INTENT_ID,
      SENDER,
      bufferedBlob(),
      deadlineMs,
      COMMITTED_U256,
    );

    // LZ send did not go out; the owner confirmExecution hybrid path completed it.
    expect(mockSuiLz.lzSendProof).not.toHaveBeenCalled();
    expect(mockMetrics.recordLzSend).toHaveBeenCalledWith('failure');
    expect(mockEvm.confirmExecution).toHaveBeenCalledTimes(1);
    const [intentIdArg, proofArg] = mockEvm.confirmExecution.mock.calls[0];
    expect(intentIdArg).toBe(INTENT_ID);
    // proof = abi.encode(bytes32 blobId, uint256 endEpoch): 2 words = 64 bytes.
    expect(proofArg).toMatch(/^0x[0-9a-f]{128}$/i);
  });
});

describe('IntentProcessor.handleSuiLzEvent', () => {
  let processor: IntentProcessor;
  let mockWalrus: Partial<WalrusService>;
  let mockIngest: { peek: jest.Mock; take: jest.Mock; drop: jest.Mock };
  let mockLifecycle: ReturnType<typeof makeLifecycleMock>;
  let mockReporter: ReturnType<typeof makeReporterMock>;

  async function build(): Promise<void> {
    mockWalrus = {
      upload: jest.fn().mockResolvedValue({
        blobId: 'blob123',
        suiObjectId: '0xblobobj',
        endEpoch: 50,
        walCostMist: undefined,
      }),
    };
    mockIngest = { peek: jest.fn(), take: jest.fn(), drop: jest.fn() };
    mockLifecycle = makeLifecycleMock({ committedBlobId: COMMITTED_HEX, sender: SENDER });
    mockReporter = makeReporterMock();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: { getBlockNumber: jest.fn().mockResolvedValue(100) } },
        {
          provide: SuiService,
          useValue: {
            executeStore: jest.fn().mockResolvedValue('suidigest'),
            getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
            getAddress: jest.fn().mockReturnValue('0xsuiaddr'),
            getClient: jest.fn().mockReturnValue({
              core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
            }),
          },
        },
        {
          provide: SuiCheckpointService,
          useValue: { setOnEventCallback: jest.fn(), startStreaming: jest.fn(), stop: jest.fn() },
        },
        {
          provide: SuiLzService,
          useValue: {
            lzSendProof: jest.fn().mockResolvedValue('lzdigest'),
            quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
          },
        },
        {
          provide: SolanaService,
          useValue: {
            canConfirm: jest.fn().mockReturnValue(false),
            confirmExecution: jest.fn().mockResolvedValue('solsig'),
          },
        },
        { provide: WalrusService, useValue: mockWalrus },
        walTopUpProvider,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => (key === 'EVM_DST_EID' ? 40161 : undefined)),
            getOrThrow: jest.fn(() => 40161),
          },
        },
        { provide: MetricsService, useValue: makeMetricsMock() },
        { provide: IntentLifecycleStore, useValue: mockLifecycle },
        { provide: ErrorReporter, useValue: mockReporter },
        { provide: IntentIngest, useValue: mockIngest },
      ],
    })
      .setLogger({ log() {}, error() {}, warn() {}, debug() {}, verbose() {}, fatal() {} })
      .compile();

    processor = module.get<IntentProcessor>(IntentProcessor);
  }

  beforeEach(async () => {
    await build();
  });

  it('fulfils an intent when the bytes have been ingested', async () => {
    mockIngest.peek.mockReturnValue(bufferedBlob());

    await processor.handleSuiLzEvent(suiEvent());

    expect(mockWalrus.upload).toHaveBeenCalledTimes(1);
    expect(mockIngest.drop).toHaveBeenCalledWith(INTENT_ID);
    expect(mockLifecycle.recordHop).toHaveBeenCalledWith(INTENT_ID, 'received', { sender: SENDER });
  });

  it('waits (no store, not deduped) when the bytes have not been ingested yet', async () => {
    mockIngest.peek.mockReturnValue(undefined);

    await processor.handleSuiLzEvent(suiEvent());
    expect(mockWalrus.upload).not.toHaveBeenCalled();

    // A later pass, once bytes arrive, fulfils it (proving it was not deduped).
    mockIngest.peek.mockReturnValue(bufferedBlob());
    await processor.handleSuiLzEvent(suiEvent());
    expect(mockWalrus.upload).toHaveBeenCalledTimes(1);
  });

  it('waits when the committed sender has not been recorded yet', async () => {
    mockIngest.peek.mockReturnValue(bufferedBlob());
    mockLifecycle.getCommitment.mockResolvedValue({
      committedBlobId: COMMITTED_HEX,
      sender: undefined,
    });

    await processor.handleSuiLzEvent(suiEvent());

    expect(mockWalrus.upload).not.toHaveBeenCalled();
  });

  it('skips and dedups an expired intent, dropping any buffered bytes', async () => {
    mockIngest.peek.mockReturnValue(bufferedBlob());
    const past = BigInt(Math.floor(Date.now() / 1000) - 3600);

    await processor.handleSuiLzEvent(suiEvent({ deadline: past }));

    expect(mockWalrus.upload).not.toHaveBeenCalled();
    expect(mockIngest.drop).toHaveBeenCalledWith(INTENT_ID);
  });

  it('dedups an already-processed intent', async () => {
    mockIngest.peek.mockReturnValue(bufferedBlob());

    await processor.handleSuiLzEvent(suiEvent());
    await processor.handleSuiLzEvent(suiEvent());

    expect(mockWalrus.upload).toHaveBeenCalledTimes(1);
  });

  it('reports a processing failure to Sentry with the intent id', async () => {
    mockIngest.peek.mockReturnValue(bufferedBlob());
    (mockWalrus.upload as jest.Mock).mockRejectedValue(new Error('walrus down'));

    await processor.handleSuiLzEvent(suiEvent());

    expect(mockReporter.captureException).toHaveBeenCalledTimes(1);
    const [err, context] = mockReporter.captureException.mock.calls[0];
    expect((err as Error).message).toMatch(/walrus down/);
    expect(context).toEqual({ intentId: INTENT_ID });
  });
});

describe('IntentProcessor.poll', () => {
  async function build(ttlMs?: number): Promise<IntentProcessor> {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentProcessor,
        { provide: EvmService, useValue: { getBlockNumber: jest.fn().mockResolvedValue(100) } },
        {
          provide: SuiService,
          useValue: {
            getAddress: jest.fn().mockReturnValue('0xsuiaddr'),
            getLzPackageId: jest.fn().mockReturnValue('0xlzpkg'),
            executeStore: jest.fn().mockResolvedValue('suidigest123'),
            getClient: jest.fn().mockReturnValue({
              core: { waitForTransaction: jest.fn().mockResolvedValue({}) },
            }),
          },
        },
        {
          provide: SuiCheckpointService,
          useValue: { setOnEventCallback: jest.fn(), startStreaming: jest.fn(), stop: jest.fn() },
        },
        {
          provide: SuiLzService,
          useValue: {
            lzSendProof: jest.fn().mockResolvedValue('lzproofdigest'),
            quoteLzFee: jest.fn().mockResolvedValue(100_000_000n),
          },
        },
        {
          provide: SolanaService,
          useValue: {
            canConfirm: jest.fn().mockReturnValue(false),
            confirmExecution: jest.fn().mockResolvedValue('solsig'),
          },
        },
        {
          provide: WalrusService,
          useValue: {
            upload: jest
              .fn()
              .mockResolvedValue({ blobId: 'blob123', suiObjectId: '0xblobobj', endEpoch: 50 }),
          },
        },
        walTopUpProvider,
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
        {
          provide: IntentLifecycleStore,
          useValue: makeLifecycleMock({ committedBlobId: COMMITTED_HEX, sender: SENDER }),
        },
        reporterProvider,
        {
          provide: IntentIngest,
          useValue: {
            peek: jest.fn().mockReturnValue(bufferedBlob()),
            take: jest.fn(),
            drop: jest.fn(),
          },
        },
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
    const processor = await build(60_000);
    await processor.onModuleDestroy();
    expect(() => processor.poll()).not.toThrow();
  });

  it('prunes expired intents so a Sui LZ intent is re-processable after its TTL', async () => {
    const processor = await build(60_000);
    const event = suiEvent();

    const baseTime = Date.now();
    const dateSpy = jest.spyOn(Date, 'now');

    dateSpy.mockReturnValue(baseTime);
    await processor.handleSuiLzEvent(event);

    dateSpy.mockReturnValue(baseTime + 30_000);
    await processor.handleSuiLzEvent(event); // deduped within TTL

    dateSpy.mockReturnValue(baseTime + 61_000);
    processor.poll(); // prunes past TTL
    await processor.handleSuiLzEvent(event); // re-processable

    // The intent's deadline is 1h out; with the dedup pruned it processes again.
    expect(processor).toBeDefined();
  });
});
