import { SentryErrorReporter, NoopErrorReporter, SentryLike } from './error-reporter';

function makeSentry() {
  const tags: Record<string, string> = {};
  const captured: unknown[] = [];
  const sentry: SentryLike = {
    withScope: (cb) => cb({ setTag: (k, v) => (tags[k] = v) }),
    captureException: (err) => captured.push(err),
  };
  return { sentry, tags, captured };
}

describe('SentryErrorReporter', () => {
  it('captures the exception and tags it with the intent id', () => {
    const { sentry, tags, captured } = makeSentry();
    const reporter = new SentryErrorReporter(sentry);
    const err = new Error('boom');

    reporter.captureException(err, { intentId: '0xabc' });

    expect(captured).toEqual([err]);
    expect(tags.intentId).toBe('0xabc');
  });

  it('captures without a tag when no intent id is given', () => {
    const { sentry, tags, captured } = makeSentry();
    const reporter = new SentryErrorReporter(sentry);

    reporter.captureException(new Error('x'));

    expect(captured).toHaveLength(1);
    expect(tags.intentId).toBeUndefined();
  });
});

describe('NoopErrorReporter', () => {
  it('does nothing and never throws', () => {
    const reporter = new NoopErrorReporter();
    expect(() => reporter.captureException(new Error('x'), { intentId: '0x1' })).not.toThrow();
  });
});
