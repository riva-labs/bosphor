import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntentIngest, blobIdMatches } from './intent-ingest.service';
import { SuiService } from '../chain/sui/sui.service';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { IntentCommitment } from '../lifecycle/intent-lifecycle.types';
import { StagedIntentStore } from '../staged/staged-intent.store';
import { StoreQueueWaker } from '../common/store-queue-waker';

const INTENT_ID = '0x' + 'ab'.repeat(32);

// A deterministic 32-byte committed blob id and its base64url encoding, which
// is what the Walrus SDK's encodeBlob returns.
const COMMITTED_BYTES = Buffer.from('cd'.repeat(32), 'hex');
const COMMITTED_HEX = '0x' + COMMITTED_BYTES.toString('hex');
const COMMITTED_BLOB_ID_B64URL = COMMITTED_BYTES.toString('base64url');

function makeCommitment(overrides: Partial<IntentCommitment> = {}): IntentCommitment {
  return {
    intentId: INTENT_ID,
    committedBlobId: COMMITTED_HEX,
    size: 5,
    deadline: Date.now() + 60_000,
    status: 'submitted',
    ...overrides,
  };
}

describe('blobIdMatches', () => {
  it('matches a base64url blob id against the equivalent 0x hex bytes32', () => {
    expect(blobIdMatches(COMMITTED_BLOB_ID_B64URL, COMMITTED_HEX)).toBe(true);
  });

  it('does not match a different blob id', () => {
    const other = Buffer.from('11'.repeat(32), 'hex').toString('base64url');
    expect(blobIdMatches(other, COMMITTED_HEX)).toBe(false);
  });

  it('returns false on undecodable input rather than throwing', () => {
    expect(blobIdMatches('', COMMITTED_HEX)).toBe(false);
  });
});

describe('IntentIngest.ingest', () => {
  let ingest: IntentIngest;
  let mockStore: { getCommitment: jest.Mock };
  let encodeBlob: jest.Mock;

  async function build(maxIngestBytes = 10_485_760): Promise<void> {
    encodeBlob = jest.fn().mockResolvedValue({ blobId: COMMITTED_BLOB_ID_B64URL });
    mockStore = { getCommitment: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentIngest,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'MAX_INGEST_BLOB_BYTES' ? maxIngestBytes : undefined,
            ),
          },
        },
        {
          provide: SuiService,
          useValue: { getWalrusClient: () => ({ walrus: { encodeBlob } }) },
        },
        { provide: IntentLifecycleStore, useValue: mockStore },
      ],
    }).compile();

    ingest = module.get(IntentIngest);
  }

  beforeEach(async () => {
    await build();
  });

  it('accepts bytes that match the commitment without uploading', async () => {
    mockStore.getCommitment.mockResolvedValue(makeCommitment());
    const bytes = Buffer.from('hello'); // length 5, matches committed size

    const result = await ingest.ingest(INTENT_ID, bytes);

    expect(result).toEqual({
      ok: true,
      intentId: INTENT_ID,
      blobId: COMMITTED_BLOB_ID_B64URL,
      size: 5,
    });
    // encodeBlob computes the id locally; there is no upload call to assert on.
    // Persistence to the staged queue is covered in the durable-queue block below.
    expect(encodeBlob).toHaveBeenCalledWith(new Uint8Array(bytes));
  });

  it('rejects with unknown when no pending intent exists', async () => {
    mockStore.getCommitment.mockResolvedValue(null);

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: 'unknown', intentId: INTENT_ID }),
    );
    expect(encodeBlob).not.toHaveBeenCalled();
  });

  it('rejects with already-executed when the intent has already stored', async () => {
    mockStore.getCommitment.mockResolvedValue(makeCommitment({ status: 'stored_walrus' }));

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'already-executed' }));
    expect(encodeBlob).not.toHaveBeenCalled();
  });

  it('rejects with expired when the deadline has passed', async () => {
    mockStore.getCommitment.mockResolvedValue(makeCommitment({ deadline: Date.now() - 1_000 }));

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'expired' }));
    expect(encodeBlob).not.toHaveBeenCalled();
  });

  it('rejects with oversized when bytes exceed the absolute cap', async () => {
    await build(4); // cap below the payload
    mockStore.getCommitment.mockResolvedValue(makeCommitment({ size: 5 }));

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello')); // 5 > 4

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'oversized' }));
    expect(encodeBlob).not.toHaveBeenCalled();
  });

  it('rejects with wrong-size when bytes do not match the committed size', async () => {
    mockStore.getCommitment.mockResolvedValue(makeCommitment({ size: 99 }));

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello')); // 5 != 99

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'wrong-size' }));
    expect(encodeBlob).not.toHaveBeenCalled();
  });

  it('rejects with wrong-blob-id when the recomputed id does not match the commitment', async () => {
    mockStore.getCommitment.mockResolvedValue(makeCommitment());
    // encodeBlob returns a different id than committed.
    encodeBlob.mockResolvedValue({
      blobId: Buffer.from('99'.repeat(32), 'hex').toString('base64url'),
    });

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'wrong-blob-id' }));
  });
});

describe('IntentIngest with the durable staged queue', () => {
  let ingest: IntentIngest;
  let mockStore: { getCommitment: jest.Mock };
  let staged: { stagedBytesTotal: jest.Mock; upsertBytes: jest.Mock };
  let waker: { wake: jest.Mock; onWake: jest.Mock };
  let encodeBlob: jest.Mock;

  async function build(maxStagedBytes = 268_435_456): Promise<void> {
    encodeBlob = jest.fn().mockResolvedValue({ blobId: COMMITTED_BLOB_ID_B64URL });
    mockStore = { getCommitment: jest.fn().mockResolvedValue(makeCommitment()) };
    staged = {
      stagedBytesTotal: jest.fn().mockResolvedValue(0),
      upsertBytes: jest.fn().mockResolvedValue('accepted'),
    };
    waker = { wake: jest.fn(), onWake: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        IntentIngest,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              if (key === 'MAX_INGEST_BLOB_BYTES') return 10_485_760;
              if (key === 'MAX_STAGED_BYTES') return maxStagedBytes;
              return undefined;
            }),
          },
        },
        { provide: SuiService, useValue: { getWalrusClient: () => ({ walrus: { encodeBlob } }) } },
        { provide: IntentLifecycleStore, useValue: mockStore },
        { provide: StagedIntentStore, useValue: staged },
        { provide: StoreQueueWaker, useValue: waker },
      ],
    }).compile();

    ingest = module.get(IntentIngest);
  }

  beforeEach(async () => {
    await build();
  });

  it('durably writes accepted bytes to the staged queue as the sole sink', async () => {
    const bytes = Buffer.from('hello');
    const result = await ingest.ingest(INTENT_ID, bytes);

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    // The cap is passed so the write enforces it atomically (not the fast-path read).
    expect(staged.upsertBytes).toHaveBeenCalledWith(
      INTENT_ID,
      { bytes, blobId: COMMITTED_BLOB_ID_B64URL, size: 5 },
      268_435_456,
    );
    // Event-driven drain: staging nudges the processor to store without waiting
    // for the poll interval.
    expect(waker.wake).toHaveBeenCalledTimes(1);
  });

  it('does not wake the queue when the bytes are refused by backpressure', async () => {
    await build(100);
    staged.upsertBytes.mockResolvedValue('backpressure');

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'backpressure' }));
    expect(waker.wake).not.toHaveBeenCalled();
  });

  it('rejects with backpressure when the staged total plus this blob exceeds the ceiling', async () => {
    await build(100); // ceiling 100 bytes
    staged.stagedBytesTotal.mockResolvedValue(96); // 96 + 5 > 100

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'backpressure' }));
    // Load is shed before the CPU-heavy recompute and without persisting anything.
    expect(encodeBlob).not.toHaveBeenCalled();
    expect(staged.upsertBytes).not.toHaveBeenCalled();
  });

  it('maps an atomic-write backpressure to a 503 rejection (TOCTOU: cap breached after the fast read)', async () => {
    await build(100);
    // Fast-path read sees headroom (0 + 5 <= 100), so ingest proceeds to the write.
    staged.stagedBytesTotal.mockResolvedValue(0);
    // But a concurrent ingest committed bytes first: the atomic upsert refuses.
    staged.upsertBytes.mockResolvedValue('backpressure');

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'backpressure' }));
    // The write was attempted (that is where the authoritative cap lives).
    expect(staged.upsertBytes).toHaveBeenCalled();
  });

  it('accepts right at the ceiling boundary', async () => {
    await build(100);
    staged.stagedBytesTotal.mockResolvedValue(95); // 95 + 5 == 100, not over

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(expect.objectContaining({ ok: true }));
    expect(staged.upsertBytes).toHaveBeenCalled();
  });

  it('checks backpressure only after the cheap validations (a wrong-size upload is not backpressure)', async () => {
    await build(1); // ceiling 1 byte: everything would be "full"
    mockStore.getCommitment.mockResolvedValue(makeCommitment({ size: 99 }));

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello')); // 5 != 99

    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'wrong-size' }));
    expect(staged.stagedBytesTotal).not.toHaveBeenCalled();
  });

  it('encode() derives the blob id from bytes without storing or checking a commitment', async () => {
    const result = await ingest.encode(Buffer.from('hello world')); // length 11

    expect(result).toEqual({ blobId: COMMITTED_BLOB_ID_B64URL, size: 11 });
    expect(encodeBlob).toHaveBeenCalledTimes(1);
    // No commitment lookup: pure offline encode, nothing stored.
    expect(mockStore.getCommitment).not.toHaveBeenCalled();
  });
});
