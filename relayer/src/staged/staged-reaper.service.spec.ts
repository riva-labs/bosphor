import { Logger } from '@nestjs/common';
import { StagedReaper } from './staged-reaper.service';

/** A quiet store stub: nothing to expire or purge, empty queue. */
function storeStub() {
  return {
    expireDue: jest.fn().mockResolvedValue(0),
    expireUnreceived: jest.fn().mockResolvedValue([] as string[]),
    purgeTerminal: jest.fn().mockResolvedValue(0),
    stats: jest.fn().mockResolvedValue({ active: 0, dead: 0, bytes: 0 }),
  };
}

function build(cfg: Record<string, number> = {}, staged: unknown = undefined) {
  const store = staged ?? storeStub();
  const config = { get: jest.fn((k: string) => cfg[k]) };
  const errorReporter = { captureException: jest.fn() };
  const metrics = { setStagedQueueStats: jest.fn(), recordOrphanExpired: jest.fn() };
  const reaper = new StagedReaper(
    config as never,
    errorReporter as never,
    metrics as never,
    store as never,
  );
  return { reaper, store, errorReporter, metrics };
}

describe('StagedReaper', () => {
  it('expires past-deadline rows and purges terminal rows past retention', async () => {
    const store = {
      ...storeStub(),
      expireDue: jest.fn().mockResolvedValue(2),
      purgeTerminal: jest.fn().mockResolvedValue(3),
      stats: jest.fn().mockResolvedValue({ active: 0, dead: 0, bytes: 0 }),
    };
    const { reaper } = build({ STAGED_RETENTION_MS: 60_000 }, store);
    const before = Date.now();
    await reaper.reap();

    expect(store.expireDue).toHaveBeenCalledTimes(1);
    expect(store.purgeTerminal).toHaveBeenCalledTimes(1);
    // Purge cutoff is now - retention.
    const [cutoff] = store.purgeTerminal.mock.calls[0];
    expect(cutoff).toBeLessThanOrEqual(before);
    expect(cutoff).toBeGreaterThanOrEqual(before - 60_000 - 1_000);
  });

  it('defaults retention to 24h when unset', async () => {
    const store = {
      ...storeStub(),
      expireDue: jest.fn().mockResolvedValue(0),
      purgeTerminal: jest.fn().mockResolvedValue(0),
      stats: jest.fn().mockResolvedValue({ active: 0, dead: 0, bytes: 0 }),
    };
    const { reaper } = build({}, store);
    const before = Date.now();
    await reaper.reap();

    const [cutoff] = store.purgeTerminal.mock.calls[0];
    expect(cutoff).toBeLessThanOrEqual(before - 86_400_000 + 1_000);
  });

  it('counts orphan expiries in Prometheus so a lost forward delivery stays on the dashboard (#494)', async () => {
    const store = {
      ...storeStub(),
      expireUnreceived: jest.fn().mockResolvedValue(['0xorphan1', '0xorphan2']),
    };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { reaper, metrics } = build({}, store);
    await reaper.reap();
    expect(metrics.recordOrphanExpired).toHaveBeenCalledWith(2);
    warn.mockRestore();
  });

  it('expires un-received rows older than STAGED_UNRECEIVED_TTL_MS and names them in a warning', async () => {
    const store = {
      ...storeStub(),
      expireUnreceived: jest.fn().mockResolvedValue(['0xorphan1', '0xorphan2']),
    };
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { reaper } = build({ STAGED_UNRECEIVED_TTL_MS: 3_600_000 }, store);
    const before = Date.now();
    await reaper.reap();
    const after = Date.now();

    const [cutoff, now] = store.expireUnreceived.mock.calls[0];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
    expect(cutoff).toBe(now - 3_600_000);
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('IntentReceived never arrived');
    expect(logged).toContain('0xorphan1');
    warn.mockRestore();
  });

  it('defaults the un-received TTL to 7 days, outlasting a multi-day forward outage', async () => {
    const store = storeStub();
    const { reaper } = build({}, store);
    await reaper.reap();

    const [cutoff, now] = store.expireUnreceived.mock.calls[0];
    expect(now - cutoff).toBe(7 * 86_400_000);
  });

  it('publishes queue-depth gauges from the post-reap stats snapshot', async () => {
    const store = {
      ...storeStub(),
      expireDue: jest.fn().mockResolvedValue(0),
      purgeTerminal: jest.fn().mockResolvedValue(0),
      stats: jest.fn().mockResolvedValue({ active: 7, dead: 2, bytes: 4096 }),
    };
    const { reaper, metrics } = build({}, store);
    await reaper.reap();

    expect(metrics.setStagedQueueStats).toHaveBeenCalledWith({ active: 7, dead: 2, bytes: 4096 });
  });

  it('is inert when the durable queue is disabled (staged null)', async () => {
    const { reaper } = build({}, null);
    await expect(reaper.reap()).resolves.toBeUndefined();
  });

  it('does not run reentrantly while a prior pass is in flight', async () => {
    let resolveExpire!: (n: number) => void;
    const store = {
      ...storeStub(),
      expireDue: jest
        .fn()
        .mockImplementationOnce(() => new Promise<number>((r) => (resolveExpire = r)))
        .mockResolvedValue(0),
      purgeTerminal: jest.fn().mockResolvedValue(0),
      stats: jest.fn().mockResolvedValue({ active: 0, dead: 0, bytes: 0 }),
    };
    const { reaper } = build({}, store);
    const first = reaper.reap();
    await reaper.reap(); // should no-op: first pass still running
    expect(store.expireDue).toHaveBeenCalledTimes(1);

    resolveExpire(0);
    await first;
    await reaper.reap(); // guard released -> runs again
    expect(store.expireDue).toHaveBeenCalledTimes(2);
  });

  it('reports a reap failure loudly and stays runnable', async () => {
    const store = {
      ...storeStub(),
      expireDue: jest.fn().mockRejectedValue(new Error('db down')),
      purgeTerminal: jest.fn().mockResolvedValue(0),
      stats: jest.fn().mockResolvedValue({ active: 0, dead: 0, bytes: 0 }),
    };
    const { reaper, errorReporter } = build({}, store);
    await expect(reaper.reap()).resolves.toBeUndefined();
    expect(errorReporter.captureException).toHaveBeenCalledTimes(1);

    // Guard is released after a failure, so the next tick retries.
    store.expireDue.mockResolvedValue(0);
    await reaper.reap();
    expect(store.expireDue).toHaveBeenCalledTimes(2);
  });
});
