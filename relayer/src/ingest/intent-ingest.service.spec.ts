import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { IntentIngest, blobIdMatches } from './intent-ingest.service';
import { SuiService } from '../chain/sui/sui.service';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { IntentCommitment } from '../lifecycle/intent-lifecycle.types';

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

  it('accepts bytes that match the commitment and buffers them without uploading', async () => {
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
    expect(encodeBlob).toHaveBeenCalledWith(new Uint8Array(bytes));
    // The accepted bytes are buffered for the processor to store later.
    const buffered = ingest.peek(INTENT_ID);
    expect(buffered?.bytes.equals(bytes)).toBe(true);
    expect(buffered?.blobId).toBe(COMMITTED_BLOB_ID_B64URL);
  });

  it('rejects with unknown when no pending intent exists', async () => {
    mockStore.getCommitment.mockResolvedValue(null);

    const result = await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: 'unknown', intentId: INTENT_ID }),
    );
    expect(encodeBlob).not.toHaveBeenCalled();
    expect(ingest.peek(INTENT_ID)).toBeUndefined();
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
    expect(ingest.peek(INTENT_ID)).toBeUndefined();
  });

  it('take() returns and removes the buffered blob', async () => {
    mockStore.getCommitment.mockResolvedValue(makeCommitment());
    await ingest.ingest(INTENT_ID, Buffer.from('hello'));

    const taken = ingest.take(INTENT_ID);
    expect(taken?.blobId).toBe(COMMITTED_BLOB_ID_B64URL);
    expect(ingest.peek(INTENT_ID)).toBeUndefined();
    expect(ingest.take(INTENT_ID)).toBeUndefined();
  });
});
