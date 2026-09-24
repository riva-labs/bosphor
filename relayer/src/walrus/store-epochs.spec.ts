import { resolveStoreEpochs } from './store-epochs';

const policy = { defaultEpochs: 5, maxEpochs: 53 };

describe('resolveStoreEpochs', () => {
  it('stores for exactly the committed epochs', () => {
    expect(resolveStoreEpochs(12, policy)).toEqual({
      ok: true,
      epochs: 12,
      source: 'committed',
    });
  });

  it('accepts a commitment equal to the max', () => {
    expect(resolveStoreEpochs(53, policy)).toEqual({
      ok: true,
      epochs: 53,
      source: 'committed',
    });
  });

  it('rejects a commitment above the max instead of silently shortening it', () => {
    const r = resolveStoreEpochs(54, policy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('exceed the max storable 53');
  });

  it('stores a committed 0 for the Walrus minimum of one epoch', () => {
    expect(resolveStoreEpochs(0, policy)).toEqual({ ok: true, epochs: 1, source: 'committed' });
  });

  it('rejects a non-integer or negative commitment', () => {
    expect(resolveStoreEpochs(2.5, policy).ok).toBe(false);
    expect(resolveStoreEpochs(-1, policy).ok).toBe(false);
  });

  it('falls back to the default only when the commitment has no epochs', () => {
    expect(resolveStoreEpochs(undefined, policy)).toEqual({
      ok: true,
      epochs: 5,
      source: 'legacy_default',
    });
    expect(resolveStoreEpochs(null, policy)).toEqual({
      ok: true,
      epochs: 5,
      source: 'legacy_default',
    });
  });

  it('rejects the legacy default when it is itself above the max', () => {
    expect(resolveStoreEpochs(undefined, { defaultEpochs: 10, maxEpochs: 3 }).ok).toBe(false);
  });
});
