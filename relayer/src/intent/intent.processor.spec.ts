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

import { IntentProcessor } from './intent.processor';
import { StagedIntentRow } from '../staged/staged-intent.types';

// A committed blob id and its base64url form, matching the ingest spec so
// blobIdMatches(row.blobId, commitment.committedBlobId) holds.
const COMMITTED_BYTES = Buffer.from('cd'.repeat(32), 'hex');
const COMMITTED_HEX = '0x' + COMMITTED_BYTES.toString('hex');
const COMMITTED_B64URL = COMMITTED_BYTES.toString('base64url');
const OTHER_B64URL = Buffer.from('11'.repeat(32), 'hex').toString('base64url');

const SOLANA_SRC_EID = 40168;

function makeRow(o: Partial<StagedIntentRow> = {}): StagedIntentRow {
  return {
    intentId: '0xintent',
    committedBlobId: COMMITTED_HEX,
    size: 5,
    deadline: Date.now() + 60_000,
    srcEid: 40161,
    received: true,
    hasBytes: true,
    blobId: COMMITTED_B64URL,
    walrusObjectId: undefined,
    walrusBlobId: undefined,
    endEpoch: undefined,
    storeDigest: undefined,
    returned: false,
    state: 'active',
    attempts: 0,
    nextAttemptAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...o,
  };
}

function build(rows: StagedIntentRow[] = [], cfgOverrides: Record<string, number> = {}) {
  const staged = {
    markReceived: jest.fn().mockResolvedValue(undefined),
    drainDue: jest.fn().mockResolvedValue(rows),
    fetchBytes: jest.fn().mockResolvedValue(Buffer.from('hello')),
    persistUpload: jest.fn().mockResolvedValue(undefined),
    persistStore: jest.fn().mockResolvedValue(undefined),
    markReturned: jest.fn().mockResolvedValue(undefined),
    freeBytes: jest.fn().mockResolvedValue(undefined),
    markDone: jest.fn().mockResolvedValue(undefined),
    markDead: jest.fn().mockResolvedValue(undefined),
    reschedule: jest.fn().mockResolvedValue(undefined),
  };
  const walrus = {
    upload: jest.fn().mockResolvedValue({
      // A valid 32-byte base64url blob id so the return leg's canonical
      // big-endian conversion (walrusBlobIdToField) succeeds.
      blobId: COMMITTED_B64URL,
      suiObjectId: '0xobj',
      endEpoch: 42,
      walCostMist: undefined,
    }),
  };
  const sui = {
    executeStore: jest.fn().mockResolvedValue('0xstore'),
    getClient: () => ({ core: { waitForTransaction: jest.fn().mockResolvedValue(undefined) } }),
    getAddress: () => '0xrelayer',
    getLzPackageId: () => '0xpkg',
  };
  const suiLz = {
    quoteLzFee: jest.fn().mockResolvedValue(1000n),
    lzSendProof: jest.fn().mockResolvedValue('0xlz'),
  };
  const evm = {
    getBlockNumber: jest.fn().mockResolvedValue(1),
    confirmExecution: jest.fn().mockResolvedValue('0xevm'),
  };
  const solana = { canConfirm: () => true, confirmExecution: jest.fn().mockResolvedValue('solsig') };
  const walTopUp = { ensureWal: jest.fn().mockResolvedValue(undefined) };
  const metrics = {
    recordIntentProcessed: jest.fn(),
    observeWalrusUpload: jest.fn(),
    recordWalStorageCost: jest.fn(),
    recordLzSend: jest.fn(),
    recordDeadLetter: jest.fn(),
  };
  const lifecycle = {
    getCommitment: jest.fn().mockResolvedValue({
      intentId: '0xintent',
      committedBlobId: COMMITTED_HEX,
      size: 5,
      deadline: Date.now() + 60_000,
      sender: '0xsender',
      status: 'submitted',
    }),
    recordHop: jest.fn().mockResolvedValue(undefined),
  };
  const errorReporter = { captureException: jest.fn() };
  const suiCheckpoint = { setOnEventCallback: jest.fn(), startStreaming: jest.fn(), stop: jest.fn() };
  const cfg: Record<string, number> = {
    SOLANA_SRC_EID,
    STORE_CONCURRENCY: 4,
    MAX_STORE_ATTEMPTS: 8,
    RETURN_MAX_ATTEMPTS: 20,
    STORE_ATTEMPT_TIMEOUT_MS: 120_000,
    STORE_BACKOFF_BASE_MS: 2000,
    STORE_BACKOFF_CAP_MS: 300_000,
    SHUTDOWN_DRAIN_MS: 30_000,
    ...cfgOverrides,
  };
  const config = {
    get: jest.fn((k: string) => cfg[k]),
    getOrThrow: jest.fn((k: string) => {
      if (k === 'EVM_DST_EID') return 40161;
      throw new Error(`missing ${k}`);
    }),
  };
  const proc = new IntentProcessor(
    evm as never,
    sui as never,
    suiCheckpoint as never,
    suiLz as never,
    solana as never,
    walrus as never,
    walTopUp as never,
    config as never,
    metrics as never,
    lifecycle as never,
    errorReporter as never,
    staged as never,
  );
  return { proc, staged, walrus, sui, suiLz, evm, solana, metrics, lifecycle };
}

describe('IntentProcessor durable queue', () => {
  it('onReceived durably records the event with seconds->ms deadline and hex blob id', async () => {
    const { proc, staged } = build();
    await proc.onReceived({
      intentId: '0xintent',
      committedBlobId: BigInt(COMMITTED_HEX).toString(), // u256 decimal
      size: 5,
      encodingType: 0,
      storageEpochs: 5,
      deadline: 1_700_000_000n, // seconds
      srcEid: 40161,
      nonce: 1n,
    } as never);

    expect(staged.markReceived).toHaveBeenCalledWith('0xintent', {
      srcEid: 40161,
      committedBlobId: COMMITTED_HEX,
      deadline: 1_700_000_000_000, // ms
    });
  });

  it('stores a ready row end to end: upload -> execute_store -> return -> done', async () => {
    const { proc, staged, walrus, sui, suiLz } = build([makeRow()]);
    await proc.tick();

    expect(walrus.upload).toHaveBeenCalledTimes(1);
    expect(staged.persistUpload).toHaveBeenCalledWith('0xintent', {
      walrusObjectId: '0xobj',
      walrusBlobId: COMMITTED_B64URL,
      endEpoch: 42,
    });
    expect(sui.executeStore).toHaveBeenCalledTimes(1);
    expect(staged.persistStore).toHaveBeenCalledWith('0xintent', '0xstore');
    expect(staged.freeBytes).toHaveBeenCalledWith('0xintent');
    expect(suiLz.lzSendProof).toHaveBeenCalledTimes(1);
    expect(staged.markReturned).toHaveBeenCalledWith('0xintent');
    expect(staged.markDone).toHaveBeenCalledWith('0xintent');
  });

  it('is idempotent: a row with a prior upload + store never re-uploads or re-records', async () => {
    const { proc, staged, walrus, sui } = build([
      makeRow({ walrusObjectId: '0xobj', walrusBlobId: 'wblob', endEpoch: 42, storeDigest: '0xprev' }),
    ]);
    await proc.tick();

    expect(walrus.upload).not.toHaveBeenCalled(); // no double WAL spend
    expect(sui.executeStore).not.toHaveBeenCalled(); // no re-record
    expect(staged.freeBytes).toHaveBeenCalledWith('0xintent');
    expect(staged.markDone).toHaveBeenCalledWith('0xintent');
  });

  it('skips the return leg for an already-returned row but still settles it', async () => {
    const { proc, staged, suiLz } = build([
      makeRow({
        walrusObjectId: '0xobj',
        walrusBlobId: 'wblob',
        endEpoch: 42,
        storeDigest: '0xprev',
        returned: true,
      }),
    ]);
    await proc.tick();

    expect(suiLz.lzSendProof).not.toHaveBeenCalled();
    expect(staged.markReturned).not.toHaveBeenCalled();
    expect(staged.markDone).toHaveBeenCalledWith('0xintent');
  });

  it('dead-letters a blob-id mismatch without spending WAL', async () => {
    const { proc, staged, walrus } = build([makeRow({ blobId: OTHER_B64URL })]);
    await proc.tick();

    expect(staged.markDead).toHaveBeenCalledWith('0xintent', expect.stringContaining('does not match'));
    expect(walrus.upload).not.toHaveBeenCalled();
    expect(staged.markDone).not.toHaveBeenCalled();
  });

  it('skips a row whose committed sender is not known yet (not ready)', async () => {
    const { proc, staged, walrus, lifecycle } = build([makeRow()]);
    lifecycle.getCommitment.mockResolvedValue({ sender: undefined });
    await proc.tick();

    expect(walrus.upload).not.toHaveBeenCalled();
    expect(staged.markDone).not.toHaveBeenCalled();
  });

  it('skips rows without bytes or without the received event', async () => {
    const { proc, walrus } = build([
      makeRow({ intentId: '0xa', hasBytes: false }),
      makeRow({ intentId: '0xb', received: false }),
    ]);
    await proc.tick();
    expect(walrus.upload).not.toHaveBeenCalled();
  });

  it('bounds concurrency to STORE_CONCURRENCY per tick', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => makeRow({ intentId: `0x${i}` }));
    const { proc, staged, walrus } = build(rows);
    await proc.tick();

    // Default STORE_CONCURRENCY is 4 -> at most 4 stored this tick.
    expect(walrus.upload).toHaveBeenCalledTimes(4);
    expect(staged.markDone).toHaveBeenCalledTimes(4);
  });

  it('reschedules with exponential backoff on a transient failure', async () => {
    const { proc, staged, walrus } = build([makeRow({ attempts: 2 })]);
    walrus.upload.mockRejectedValue(new Error('walrus down'));
    const now = Date.now();
    await proc.tick();

    expect(staged.reschedule).toHaveBeenCalledTimes(1);
    const [id, attempts, nextAt, err] = staged.reschedule.mock.calls[0];
    expect(id).toBe('0xintent');
    expect(attempts).toBe(3); // 2 + 1
    expect(nextAt).toBeGreaterThanOrEqual(now + 16_000); // base 2000 * 2^3
    expect(err).toContain('walrus down');
    expect(staged.markDone).not.toHaveBeenCalled();
  });

  it('dead-letters a pre-store failure once attempts are exhausted', async () => {
    const { proc, staged, metrics, walrus } = build([makeRow({ attempts: 2 })], {
      MAX_STORE_ATTEMPTS: 3,
    });
    walrus.upload.mockRejectedValue(new Error('walrus down'));
    await proc.tick();

    expect(staged.markDead).toHaveBeenCalledWith('0xintent', expect.stringContaining('attempts exhausted'));
    expect(metrics.recordDeadLetter).toHaveBeenCalledWith('pre_store');
    expect(staged.reschedule).not.toHaveBeenCalled(); // dead, not rescheduled
  });

  it('retries a post-store (return-leg) failure without dead-lettering the storage', async () => {
    const { proc, staged, metrics, suiLz, evm } = build([makeRow()]);
    // Both the LZ send and the confirmExecution fallback fail -> return leg throws.
    suiLz.lzSendProof.mockRejectedValue(new Error('lz down'));
    evm.confirmExecution.mockRejectedValue(new Error('evm down'));
    await proc.tick();

    // Blob was stored (upload + execute persisted, bytes freed) before the failure.
    expect(staged.persistStore).toHaveBeenCalled();
    expect(staged.freeBytes).toHaveBeenCalledWith('0xintent');
    // Return leg retries; storage is never dead-lettered.
    expect(staged.reschedule).toHaveBeenCalledTimes(1);
    expect(staged.markDead).not.toHaveBeenCalled();
    expect(metrics.recordDeadLetter).not.toHaveBeenCalled();
  });

  it('alerts (but does not dead-letter) when the return leg exceeds its budget', async () => {
    const { proc, staged, metrics, suiLz, evm } = build([makeRow({ attempts: 1 })], {
      RETURN_MAX_ATTEMPTS: 2,
    });
    suiLz.lzSendProof.mockRejectedValue(new Error('lz down'));
    evm.confirmExecution.mockRejectedValue(new Error('evm down'));
    await proc.tick();

    expect(metrics.recordDeadLetter).toHaveBeenCalledWith('return');
    expect(staged.reschedule).toHaveBeenCalledTimes(1); // still retries
    expect(staged.markDead).not.toHaveBeenCalled(); // storage stays safe
  });

  it('aborts a hung store at the attempt timeout and reschedules', async () => {
    const { proc, staged, walrus } = build([makeRow()], { STORE_ATTEMPT_TIMEOUT_MS: 20 });
    // Upload hangs well past the 20ms timeout.
    walrus.upload.mockReturnValue(
      new Promise((res) => setTimeout(() => res({ blobId: COMMITTED_B64URL, suiObjectId: '0xobj', endEpoch: 42, walCostMist: undefined }), 200)),
    );
    await proc.tick();

    expect(staged.reschedule).toHaveBeenCalledTimes(1);
    expect(staged.reschedule.mock.calls[0][3]).toContain('exceeded');
    // Let the hung upload settle so it releases the in-process slot cleanly.
    await new Promise((r) => setTimeout(r, 250));
  });

  it('routes a Solana-origin intent through confirm_execution, not the EVM leg', async () => {
    const { proc, solana, suiLz } = build([makeRow({ srcEid: SOLANA_SRC_EID })]);
    await proc.tick();

    expect(solana.confirmExecution).toHaveBeenCalledTimes(1);
    expect(suiLz.lzSendProof).not.toHaveBeenCalled();
  });

  it('reuses a persisted upload after a crash (retry runs execute_store, no re-spend)', async () => {
    const { proc, staged, walrus, sui } = build([
      makeRow({ walrusObjectId: '0xobj', walrusBlobId: 'wblob', endEpoch: 42 }),
    ]);
    await proc.tick();

    expect(walrus.upload).not.toHaveBeenCalled();
    expect(sui.executeStore).toHaveBeenCalledTimes(1);
    expect(staged.markDone).toHaveBeenCalledWith('0xintent');
  });

  it('is inert when the durable queue is disabled (staged null)', async () => {
    const { proc } = build();
    (proc as unknown as { staged: null }).staged = null;
    await expect(proc.tick()).resolves.toBeUndefined();
  });

  it('graceful shutdown drains promptly when nothing is in flight', async () => {
    const { proc } = build();
    const start = Date.now();
    await proc.onModuleDestroy();
    // No in-flight store -> returns without waiting out the drain budget.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it('graceful shutdown gives up at SHUTDOWN_DRAIN_MS if a store never settles', async () => {
    const { proc } = build([], { SHUTDOWN_DRAIN_MS: 150 });
    // Pin a fake in-flight store so the drain loop never sees inProcess empty.
    (proc as unknown as { inProcess: Set<string> }).inProcess.add('0xstuck');
    const start = Date.now();
    await proc.onModuleDestroy();
    const elapsed = Date.now() - start;
    // Waited out the budget (not forever) then exited.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(2_000);
  });
});
