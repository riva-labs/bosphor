import { hostname } from 'node:os';
import { StagedIntentStore, PgQueryable } from './staged-intent.store';

/**
 * A behavioural in-memory stand-in for a pg Pool that understands the query
 * shapes StagedIntentStore issues. It models rows in a Map and applies the same
 * semantics real Postgres would (ON CONFLICT with the `state='active'` guard,
 * the atomic claim filter with its lease predicate, SUM over rows that still
 * hold bytes, expiry, purge), so the tests assert behaviour, not SQL strings.
 * Each query() call is atomic, mirroring how the single claim UPDATE (FOR
 * UPDATE SKIP LOCKED) serialises concurrent claimers in real Postgres. Mirrors
 * the FakePool pattern in pg-intent-lifecycle.store.spec.ts.
 */
type Row = Record<string, unknown> & { bytes: Buffer | null };

class FakePool implements PgQueryable {
  readonly rows = new Map<string, Row>();

  async query(text: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const sql = text.toLowerCase();

    if (sql.includes('create table') || sql.includes('create index') || sql.includes('alter table'))
      return { rows: [] };

    if (sql.startsWith('insert into')) return this.upsert(sql, params);

    if (sql.startsWith('delete from')) {
      const cutoff = params[0] as number;
      const purged: Record<string, unknown>[] = [];
      for (const [id, r] of this.rows) {
        if (
          ['done', 'dead', 'expired'].includes(r.state as string) &&
          (r.updated_at as number) < cutoff
        ) {
          purged.push({ intent_id: id });
          this.rows.delete(id);
        }
      }
      return { rows: purged };
    }

    if (sql.startsWith('update')) return this.update(sql, params);

    if (sql.includes('select bytes from')) {
      const r = this.rows.get(params[0] as string);
      return { rows: r ? [{ bytes: r.bytes }] : [] };
    }

    // stats() aggregate - checked before the plain SUM(size) branch because this
    // query also contains "sum(size)" (as a FILTER'd column).
    if (sql.includes('count(*) filter')) {
      let active = 0;
      let dead = 0;
      let bytes = 0;
      for (const r of this.rows.values()) {
        if (r.state === 'active') active++;
        if (r.state === 'dead') dead++;
        if (r.bytes !== null && r.size != null) bytes += Number(r.size);
      }
      return { rows: [{ active, dead, bytes }] };
    }

    if (sql.includes('sum(size)')) {
      let total = 0;
      for (const r of this.rows.values()) {
        if (r.bytes !== null && r.size != null) total += Number(r.size);
      }
      return { rows: [{ total }] };
    }

    // Byte-recovery claim: received, no bytes, past grace, not expired, not gated.
    if (sql.includes('committed_blob_id is not null')) {
      const now = params[0] as number;
      const grace = params[1] as number;
      const limit = params[2] as number;
      const due = [...this.rows.values()]
        .filter(
          (r) =>
            r.state === 'active' &&
            r.received === true &&
            r.bytes === null &&
            r.committed_blob_id != null &&
            r.walrus_object_id == null &&
            r.store_digest == null &&
            (r.deadline == null || (r.deadline as number) > now) &&
            ((r.bytes_recovery_at as number | null) ?? (r.created_at as number) + grace) <= now,
        )
        .sort((a, b) => (a.created_at as number) - (b.created_at as number))
        .slice(0, limit)
        .map((r) => ({ intent_id: r.intent_id, committed_blob_id: r.committed_blob_id }));
      return { rows: due };
    }

    if (sql.includes('where intent_id = $1')) {
      const r = this.rows.get(params[0] as string);
      return { rows: r ? [this.project(r)] : [] };
    }

    throw new Error(`unexpected query: ${text}`);
  }

  /** Metadata projection: has_bytes derived, bytes payload withheld (as the store's SELECTs do). */
  private project(r: Row): Record<string, unknown> {
    const { bytes, ...rest } = r;
    return { ...rest, has_bytes: bytes !== null };
  }

  private upsert(sql: string, params: unknown[]): { rows: Record<string, unknown>[] } {
    const id = params[0] as string;
    const existing = this.rows.get(id);
    const isBytes = sql.includes('bytes,'); // upsertBytes column list carries `bytes`

    if (existing) {
      // ON CONFLICT ... WHERE state='active' - terminal rows are untouched.
      if (existing.state !== 'active') return { rows: [] };
      if (isBytes) {
        existing.bytes = params[1] as Buffer;
        existing.blob_id = params[2] as string;
        existing.size = params[3] as number;
        existing.updated_at = params[4] as number;
      } else {
        existing.received = true;
        existing.src_eid = params[1] as number;
        existing.committed_blob_id = params[2] as string;
        existing.deadline = params[3] as number;
        existing.updated_at = params[4] as number;
        // COALESCE(EXCLUDED.delivery_digest, existing): a later event without a
        // digest never clobbers one already captured.
        existing.delivery_digest = (params[5] as string | null) ?? existing.delivery_digest;
      }
      return { rows: [] };
    }

    const now = isBytes ? (params[4] as number) : (params[4] as number);
    const base: Row = {
      intent_id: id,
      committed_blob_id: null,
      size: null,
      deadline: null,
      src_eid: null,
      received: false,
      bytes: null,
      blob_id: null,
      walrus_object_id: null,
      walrus_blob_id: null,
      end_epoch: null,
      store_digest: null,
      delivery_digest: null,
      bytes_recovery_at: null,
      returned: false,
      state: 'active',
      attempts: 0,
      next_attempt_at: now,
      claimed_by: null,
      lease_expires_at: null,
      last_error: null,
      created_at: now,
      updated_at: now,
    };
    if (isBytes) {
      base.bytes = params[1] as Buffer;
      base.blob_id = params[2] as string;
      base.size = params[3] as number;
    } else {
      base.received = true;
      base.src_eid = params[1] as number;
      base.committed_blob_id = params[2] as string;
      base.deadline = params[3] as number;
      base.delivery_digest = (params[5] as string | null) ?? null;
    }
    this.rows.set(id, base);
    return { rows: [] };
  }

  private update(sql: string, params: unknown[]): { rows: Record<string, unknown>[] } {
    // Bulk expire has no intent_id param - it scans by deadline.
    if (sql.includes("state = 'expired'")) {
      const now = params[0] as number;
      const expired: Record<string, unknown>[] = [];
      for (const [id, r] of this.rows) {
        if (r.state === 'active' && r.deadline != null && (r.deadline as number) < now) {
          r.state = 'expired';
          r.bytes = null;
          r.updated_at = now;
          expired.push({ intent_id: id });
        }
      }
      return { rows: expired };
    }

    // The atomic drain claim: filter with the lease predicate, stamp the lease
    // on the claimed rows, and RETURNING them - all in one call, as the single
    // UPDATE ... FOR UPDATE SKIP LOCKED statement does in real Postgres.
    if (sql.includes('claimed_by = $3')) {
      const now = params[0] as number;
      const limit = params[1] as number;
      const claimant = params[2] as string;
      const leaseMs = params[3] as number;
      const claimed = [...this.rows.values()]
        .filter(
          (r) =>
            r.state === 'active' &&
            (r.next_attempt_at as number) <= now &&
            // SQL: claimed_by IS NULL OR claimed_by = $3 OR lease_expires_at < $1
            // (a NULL lease_expires_at makes the comparison false, as in SQL).
            (r.claimed_by == null ||
              r.claimed_by === claimant ||
              (r.lease_expires_at != null && (r.lease_expires_at as number) < now)),
        )
        .sort((a, b) => (a.created_at as number) - (b.created_at as number))
        .slice(0, limit);
      for (const r of claimed) {
        r.claimed_by = claimant;
        r.lease_expires_at = now + leaseMs;
        r.updated_at = now;
      }
      return { rows: claimed.map((r) => this.project(r)) };
    }

    const r = this.rows.get(params[0] as string);
    if (!r) return { rows: [] };

    if (sql.includes('walrus_object_id = $2')) {
      r.walrus_object_id = params[1] as string;
      r.walrus_blob_id = params[2] as string;
      r.end_epoch = params[3] as number;
      r.updated_at = params[4] as number;
    } else if (sql.includes('store_digest = $2')) {
      r.store_digest = params[1] as string;
      r.updated_at = params[2] as number;
    } else if (sql.includes('returned = true')) {
      r.returned = true;
      r.updated_at = params[1] as number;
    } else if (sql.includes("state = 'done'")) {
      r.state = 'done';
      r.bytes = null;
      r.updated_at = params[1] as number;
    } else if (sql.includes("state = 'dead'")) {
      r.state = 'dead';
      r.bytes = null;
      r.last_error = params[1] as string;
      r.updated_at = params[2] as number;
    } else if (sql.includes('attempts = $2')) {
      r.attempts = params[1] as number;
      r.next_attempt_at = params[2] as number;
      r.last_error = params[3] as string;
      r.updated_at = params[4] as number;
      // reschedule() releases the claim lease alongside the backoff.
      r.claimed_by = null;
      r.lease_expires_at = null;
    } else if (sql.includes('bytes_recovery_at = $2')) {
      r.bytes_recovery_at = params[1] as number;
      r.updated_at = params[2] as number;
    } else if (sql.includes('bytes = null')) {
      r.bytes = null;
      r.updated_at = params[1] as number;
    } else {
      throw new Error(`unexpected update: ${sql}`);
    }
    return { rows: [] };
  }
}

const RX = { srcEid: 40161, committedBlobId: '0x' + 'ab'.repeat(32), deadline: 2_000_000_000_000 };

describe('StagedIntentStore', () => {
  let clock = 1_000;
  beforeEach(() => {
    clock = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
  });
  afterEach(() => jest.restoreAllMocks());

  const bytes = (s: string) => Buffer.from(s);

  it('creates the table and drain index on init', async () => {
    const pool = new FakePool();
    const seen: string[] = [];
    const spy = jest.spyOn(pool, 'query').mockImplementation(async (t: string) => {
      seen.push(t.toLowerCase());
      return { rows: [] };
    });
    await new StagedIntentStore(pool).init();
    expect(seen.some((q) => q.includes('create table'))).toBe(true);
    expect(seen.some((q) => q.includes('create index') && q.includes('drain_idx'))).toBe(true);
    spy.mockRestore();
  });

  it('buffers bytes as a new active row, then merges the received event onto it', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0xa', { bytes: bytes('hello'), blobId: 'blob-a', size: 5 });
    let row = await store.get('0xa');
    expect(row?.state).toBe('active');
    expect(row?.hasBytes).toBe(true);
    expect(row?.blobId).toBe('blob-a');
    expect(row?.size).toBe(5);
    expect(row?.received).toBe(false);

    await store.markReceived('0xa', RX);
    row = await store.get('0xa');
    expect(row?.received).toBe(true);
    expect(row?.srcEid).toBe(RX.srcEid);
    expect(row?.deadline).toBe(RX.deadline);
    expect(row?.hasBytes).toBe(true); // bytes not wiped by the event
  });

  it('persists the Sui delivery digest and never clobbers it with a later digest-less event', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.markReceived('0xd', { ...RX, deliveryDigest: '0xdeliver' });
    expect((await store.get('0xd'))?.deliveryDigest).toBe('0xdeliver');

    // A backfilled re-observation without a digest must keep the captured one.
    await store.markReceived('0xd', RX);
    expect((await store.get('0xd'))?.deliveryDigest).toBe('0xdeliver');
  });

  it('claimForByteRecovery selects received-without-bytes past grace, and backs off', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);
    const GRACE = 45_000;

    await store.markReceived('0xr', RX); // received, no bytes
    const t0 = (await store.get('0xr'))!.createdAt;

    // Within the grace window: not yet eligible.
    expect(await store.claimForByteRecovery(t0 + GRACE - 1, GRACE, 10)).toHaveLength(0);

    // Past the grace: eligible, carrying the commitment to re-fetch.
    const due = await store.claimForByteRecovery(t0 + GRACE + 1, GRACE, 10);
    expect(due).toEqual([{ intentId: '0xr', committedBlobId: RX.committedBlobId }]);

    // A row that already has bytes is never a candidate.
    await store.upsertBytes('0xr', { bytes: bytes('data'), blobId: 'b', size: 4 });
    expect(await store.claimForByteRecovery(t0 + GRACE + 1, GRACE, 10)).toHaveLength(0);

    // Backoff gates the next attempt until its time.
    await store.markReceived('0xr2', RX);
    const t2 = (await store.get('0xr2'))!.createdAt;
    await store.rescheduleByteRecovery('0xr2', t2 + 100_000);
    expect(await store.claimForByteRecovery(t2 + GRACE + 1, GRACE, 10)).toHaveLength(0);
    expect(await store.claimForByteRecovery(t2 + 100_001, GRACE, 10)).toHaveLength(1);
  });

  it('never sweeps a post-store row (return-retry): store done, only return pending', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);
    const GRACE = 45_000;

    // A pre-store row that never got bytes: still a recovery candidate.
    await store.markReceived('0xpre', RX);
    const pre = (await store.get('0xpre'))!.createdAt;
    expect(await store.claimForByteRecovery(pre + GRACE + 1, GRACE, 10)).toEqual([
      { intentId: '0xpre', committedBlobId: RX.committedBlobId },
    ]);

    // A row that stored (Walrus upload + execute_store done) and later purged its
    // bytes while the return leg retries: it looks bytes-less, but the store step
    // is complete, so there is nothing to recover. It must never be swept.
    await store.markReceived('0xpost', RX);
    await store.persistUpload('0xpost', {
      walrusObjectId: '0xobj',
      walrusBlobId: 'wb',
      endEpoch: 100,
    });
    await store.persistStore('0xpost', '0xstoredigest');
    const post = (await store.get('0xpost'))!.createdAt;
    const due = await store.claimForByteRecovery(post + GRACE + 1, GRACE, 10);
    expect(due.map((c) => c.intentId)).not.toContain('0xpost');
  });

  it('is order-independent: received event before bytes still ends up ready-shaped', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.markReceived('0xb', RX);
    let row = await store.get('0xb');
    expect(row?.received).toBe(true);
    expect(row?.hasBytes).toBe(false);

    await store.upsertBytes('0xb', { bytes: bytes('data'), blobId: 'blob-b', size: 4 });
    row = await store.get('0xb');
    expect(row?.received).toBe(true);
    expect(row?.hasBytes).toBe(true);
    expect(row?.blobId).toBe('blob-b');
  });

  it('is terminal-sticky: a late event cannot resurrect a done intent', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0xc', { bytes: bytes('x'), blobId: 'blob-c', size: 1 });
    await store.markDone('0xc');

    await store.markReceived('0xc', RX); // backfilled event
    const row = await store.get('0xc');
    expect(row?.state).toBe('done');
    expect(row?.received).toBe(false); // guard held; no resurrection
  });

  it('drains only active, due rows, oldest first, without the bytes payload', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    clock = 1000;
    await store.upsertBytes('0xold', { bytes: bytes('a'), blobId: 'b1', size: 1 });
    clock = 2000;
    await store.upsertBytes('0xnew', { bytes: bytes('b'), blobId: 'b2', size: 1 });
    clock = 3000;
    await store.upsertBytes('0xdone', { bytes: bytes('c'), blobId: 'b3', size: 1 });
    await store.markDone('0xdone'); // terminal -> excluded
    clock = 4000;
    await store.upsertBytes('0xfuture', { bytes: bytes('d'), blobId: 'b4', size: 1 });
    await store.reschedule('0xfuture', 1, 9_999_999, 'backoff'); // not due yet

    const due = await store.drainDue(5000, 10);
    expect(due.map((r) => r.intentId)).toEqual(['0xold', '0xnew']);
    expect((due[0] as unknown as Record<string, unknown>).bytes).toBeUndefined();
    expect(due[0].hasBytes).toBe(true);

    const limited = await store.drainDue(5000, 1);
    expect(limited.map((r) => r.intentId)).toEqual(['0xold']);
  });

  describe('claim lease (single-writer enforcement)', () => {
    const LEASE = 60_000;

    /** Two stores over the SAME pool = two relayer processes on one database. */
    const twoClaimers = async () => {
      const pool = new FakePool();
      const a = new StagedIntentStore(pool, { claimant: 'proc-a', leaseMs: LEASE });
      const b = new StagedIntentStore(pool, { claimant: 'proc-b', leaseMs: LEASE });
      clock = 1000;
      await a.upsertBytes('0x1', { bytes: bytes('a'), blobId: 'b1', size: 1 });
      clock = 2000;
      await a.upsertBytes('0x2', { bytes: bytes('b'), blobId: 'b2', size: 1 });
      return { pool, a, b };
    };

    it('derives a per-process claimant identity: hostname plus a random suffix', () => {
      const s1 = new StagedIntentStore(new FakePool());
      const s2 = new StagedIntentStore(new FakePool());
      expect(s1.claimant.startsWith(`${hostname()}-`)).toBe(true);
      expect(s1.claimant.slice(hostname().length + 1)).toMatch(/^[0-9a-f]{8}$/);
      expect(s1.claimant).not.toBe(s2.claimant); // two processes never collide
    });

    it('gives two concurrent claimers disjoint rows', async () => {
      const { a, b } = await twoClaimers();

      const claimedA = await a.drainDue(5000, 1);
      const claimedB = await b.drainDue(5000, 10);

      expect(claimedA.map((r) => r.intentId)).toEqual(['0x1']);
      expect(claimedB.map((r) => r.intentId)).toEqual(['0x2']); // 0x1 is leased out
      expect(claimedA[0].claimedBy).toBe('proc-a');
      expect(claimedB[0].claimedBy).toBe('proc-b');
      expect(claimedA[0].leaseExpiresAt).toBe(5000 + LEASE);

      // No matter how often B re-drains, A's live lease keeps 0x1 off-limits.
      const again = await b.drainDue(6000, 10);
      expect(again.map((r) => r.intentId)).toEqual(['0x2']);
    });

    it('renews the lease when the owner re-claims its own rows', async () => {
      const { a, b } = await twoClaimers();

      await a.drainDue(5000, 10);
      const renewed = await a.drainDue(30_000, 10); // next claim tick, same owner
      expect(renewed.map((r) => r.intentId)).toEqual(['0x1', '0x2']);
      expect(renewed[0].leaseExpiresAt).toBe(30_000 + LEASE);

      // The renewal pushed the horizon: B still gets nothing past the ORIGINAL expiry.
      expect(await b.drainDue(5000 + LEASE + 1, 10)).toHaveLength(0);
    });

    it('lets another process take over an expired lease (crashed owner)', async () => {
      const { a, b } = await twoClaimers();

      await a.drainDue(5000, 10); // leases expire at 65_000
      expect(await b.drainDue(65_000, 10)).toHaveLength(0); // not yet: strict <
      const taken = await b.drainDue(65_001, 10);
      expect(taken.map((r) => r.intentId)).toEqual(['0x1', '0x2']);
      expect(taken.every((r) => r.claimedBy === 'proc-b')).toBe(true);
    });

    it('reschedule releases the lease so any process may claim after the backoff', async () => {
      const { a, b } = await twoClaimers();

      await a.drainDue(5000, 10);
      await a.reschedule('0x1', 1, 8000, 'transient failure');
      expect((await a.get('0x1'))?.claimedBy).toBeUndefined();

      expect(await b.drainDue(7999, 10)).toHaveLength(0); // backoff still gates it
      const claimed = await b.drainDue(8000, 10); // well before the old lease expiry
      expect(claimed.map((r) => r.intentId)).toEqual(['0x1']);
      expect(claimed[0].claimedBy).toBe('proc-b');
    });

    it('never re-claims completed or dead-lettered intents, even past lease expiry', async () => {
      const { a, b } = await twoClaimers();

      await a.drainDue(5000, 10);
      await a.markDone('0x1');
      await a.markDead('0x2', 'attempts exhausted');

      expect(await b.drainDue(999_999_999, 10)).toHaveLength(0);
      expect(await a.drainDue(999_999_999, 10)).toHaveLength(0); // not even the owner
      expect((await a.get('0x1'))?.state).toBe('done');
      expect((await a.get('0x2'))?.state).toBe('dead');
    });
  });

  it('persists per-step results for idempotent retry and fetches/frees bytes', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0xd', { bytes: bytes('payload'), blobId: 'blob-d', size: 7 });
    expect((await store.fetchBytes('0xd'))?.toString()).toBe('payload');

    await store.persistUpload('0xd', {
      walrusObjectId: '0xobj',
      walrusBlobId: 'wblob',
      endEpoch: 42,
    });
    await store.persistStore('0xd', '0xdigest');
    await store.markReturned('0xd');
    const row = await store.get('0xd');
    expect(row?.walrusObjectId).toBe('0xobj');
    expect(row?.endEpoch).toBe(42);
    expect(row?.storeDigest).toBe('0xdigest');
    expect(row?.returned).toBe(true);

    await store.freeBytes('0xd');
    expect(await store.fetchBytes('0xd')).toBeUndefined();
  });

  it('sums staged bytes by size, counting only rows that still hold bytes', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0x1', { bytes: bytes('aa'), blobId: 'b1', size: 100 });
    await store.upsertBytes('0x2', { bytes: bytes('bb'), blobId: 'b2', size: 250 });
    expect(await store.stagedBytesTotal()).toBe(350);

    await store.markDone('0x1'); // frees bytes -> drops out of the total
    expect(await store.stagedBytesTotal()).toBe(250);
  });

  it('reports queue-depth stats: active count, dead count, and held bytes', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.upsertBytes('0x1', { bytes: bytes('aa'), blobId: 'b1', size: 100 });
    await store.upsertBytes('0x2', { bytes: bytes('bb'), blobId: 'b2', size: 250 });
    await store.upsertBytes('0x3', { bytes: bytes('cc'), blobId: 'b3', size: 999 });
    await store.markDead('0x3', 'terminal'); // dead + frees its bytes

    expect(await store.stats()).toEqual({ active: 2, dead: 1, bytes: 350 });
  });

  it('expires past-deadline active rows and frees their bytes', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    await store.markReceived('0xexp', { ...RX, deadline: 1500 });
    await store.upsertBytes('0xexp', { bytes: bytes('z'), blobId: 'b', size: 1 });
    await store.markReceived('0xlive', { ...RX, deadline: 9000 });
    await store.upsertBytes('0xlive', { bytes: bytes('z'), blobId: 'b', size: 1 });

    const expired = await store.expireDue(2000);
    expect(expired).toBe(1);
    expect((await store.get('0xexp'))?.state).toBe('expired');
    expect((await store.get('0xexp'))?.hasBytes).toBe(false);
    expect((await store.get('0xlive'))?.state).toBe('active');
  });

  it('purges terminal rows older than the cutoff, keeps active ones', async () => {
    const pool = new FakePool();
    const store = new StagedIntentStore(pool);

    clock = 1000;
    await store.upsertBytes('0xgone', { bytes: bytes('a'), blobId: 'b', size: 1 });
    await store.markDead('0xgone', 'terminal');
    clock = 5000;
    await store.upsertBytes('0xkeep', { bytes: bytes('b'), blobId: 'b', size: 1 });

    const purged = await store.purgeTerminal(3000);
    expect(purged).toBe(1);
    expect(await store.get('0xgone')).toBeUndefined();
    expect((await store.get('0xkeep'))?.state).toBe('active');
  });
});
