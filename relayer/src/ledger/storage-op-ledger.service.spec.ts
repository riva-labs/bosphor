import { StagedIntentRow } from '../staged/staged-intent.types';
import { ALREADY_RECORDED, StorageOpLedger, buildLedgerEntry } from './storage-op-ledger.service';
import { StorageOpLedgerStore } from './storage-op-ledger.store';
import { StorageOpEntry } from './storage-op-ledger.types';

function row(o: Partial<StagedIntentRow> = {}): StagedIntentRow {
  return {
    intentId: '0xa',
    committedBlobId: '0x' + 'cd'.repeat(32),
    size: 2048,
    deadline: 9_999_999,
    srcEid: 40168,
    received: true,
    hasBytes: false,
    blobId: 'b64',
    walrusObjectId: '0xobj',
    walrusBlobId: 'walrus',
    endEpoch: 7,
    storeDigest: '0xdigest',
    returned: false,
    ledgered: false,
    state: 'active',
    attempts: 0,
    nextAttemptAt: 0,
    appId: 'my-dapp',
    storedAt: 5_000,
    createdAt: 1_000,
    updatedAt: 6_000,
    ...o,
  };
}

/** In-memory ledger with the same exactly-once semantics as the Pg store. */
class MemoryLedger {
  readonly entries = new Map<string, StorageOpEntry>();
  fail = false;
  async record(e: StorageOpEntry): Promise<boolean> {
    if (this.fail) throw new Error('db down');
    if (this.entries.has(e.intentId)) return false;
    this.entries.set(e.intentId, e);
    return true;
  }
}

function build(opts: { withLedger?: boolean; pending?: StagedIntentRow[] } = {}) {
  const ledger = new MemoryLedger();
  const staged = {
    markLedgered: jest.fn().mockResolvedValue(undefined),
    pendingLedger: jest.fn().mockResolvedValue(opts.pending ?? []),
  };
  const metrics = { recordLedgerOp: jest.fn(), recordLedgerWriteFailure: jest.fn() };
  const lifecycle = {
    getCommitment: jest.fn().mockResolvedValue({
      intentId: '0xa',
      committedBlobId: '0x' + 'ab'.repeat(32),
      size: 2048,
      deadline: 1,
      sender: 'SolSender',
      status: 'recorded_sui',
    }),
  };
  const config = { get: jest.fn((k: string) => (k === 'SUI_NETWORK' ? 'mainnet' : undefined)) };
  const svc = new StorageOpLedger(
    config as never,
    metrics as never,
    lifecycle as never,
    opts.withLedger === false ? null : (ledger as unknown as StorageOpLedgerStore),
    staged as never,
  );
  return { svc, ledger, staged, metrics, lifecycle };
}

describe('buildLedgerEntry', () => {
  it('maps a completed store from the row and the commitment', () => {
    const e = buildLedgerEntry(
      { row: row(), sender: '0xsender', committedBlobId: '0xcommitted', storeDigest: '0xnew' },
      'testnet',
      123,
    );
    expect(e).toEqual({
      intentId: '0xa',
      srcEid: 40168,
      sender: '0xsender',
      size: 2048,
      blobId: '0xcommitted',
      walrusBlobId: 'walrus',
      walrusObjectId: '0xobj',
      endEpoch: 7,
      appId: 'my-dapp',
      network: 'testnet',
      storeDigest: '0xnew',
      createdAt: 1_000,
      storedAt: 5_000,
    });
  });

  it('records a null app id when none was sent, and a null digest for the marker', () => {
    const e = buildLedgerEntry(
      { row: row({ appId: undefined, storeDigest: ALREADY_RECORDED }) },
      'testnet',
      0,
    );
    expect(e.appId).toBeNull();
    expect(e.storeDigest).toBeNull();
    expect(e.sender).toBeNull();
  });

  it('uses now for a store that just completed inline (row snapshot predates it)', () => {
    const e = buildLedgerEntry(
      { row: row({ storedAt: undefined, storeDigest: undefined }), storeDigest: '0xd' },
      'testnet',
      777,
    );
    expect(e.storedAt).toBe(777);
  });

  it('falls back to the row update time for completed rows that predate stored_at', () => {
    const e = buildLedgerEntry({ row: row({ storedAt: undefined }) }, 'testnet', 777);
    expect(e.storedAt).toBe(6_000);
  });
});

describe('StorageOpLedger', () => {
  it('records once, counts the metric once, and flags the staged row', async () => {
    const { svc, ledger, staged, metrics } = build();
    expect(await svc.recordCompletedStore({ row: row() })).toBe(true);
    expect(await svc.recordCompletedStore({ row: row() })).toBe(true);
    expect(ledger.entries.size).toBe(1);
    expect(metrics.recordLedgerOp).toHaveBeenCalledTimes(1);
    expect(metrics.recordLedgerOp).toHaveBeenCalledWith(40168, 'my-dapp', 2048);
    expect(staged.markLedgered).toHaveBeenCalledWith('0xa');
    expect(ledger.entries.get('0xa')?.network).toBe('mainnet');
  });

  it('never throws on a ledger failure: counts it and leaves the row for backfill', async () => {
    const { svc, ledger, staged, metrics } = build();
    ledger.fail = true;
    await expect(svc.recordCompletedStore({ row: row() })).resolves.toBe(false);
    expect(metrics.recordLedgerWriteFailure).toHaveBeenCalledTimes(1);
    expect(staged.markLedgered).not.toHaveBeenCalled();
  });

  it('is inert without a database', async () => {
    const { svc, staged } = build({ withLedger: false });
    expect(await svc.recordCompletedStore({ row: row() })).toBe(false);
    expect(await svc.backfill()).toBe(0);
    expect(staged.pendingLedger).not.toHaveBeenCalled();
  });

  it('backfills un-ledgered completed stores with the sender from the commitment', async () => {
    const { svc, ledger, staged } = build({
      pending: [row({ intentId: '0xa' }), row({ intentId: '0xb' })],
    });
    expect(await svc.backfill()).toBe(2);
    expect(ledger.entries.get('0xa')?.sender).toBe('SolSender');
    expect(ledger.entries.get('0xa')?.blobId).toBe('0x' + 'ab'.repeat(32));
    expect(staged.markLedgered).toHaveBeenCalledTimes(2);
  });

  it('backfill skips (retries later) a row whose commitment cannot be read', async () => {
    const { svc, ledger, lifecycle } = build({ pending: [row()] });
    lifecycle.getCommitment.mockRejectedValueOnce(new Error('db blip'));
    expect(await svc.backfill()).toBe(0);
    expect(ledger.entries.size).toBe(0);
  });
});
