import { parseAppId } from './app-id';

describe('parseAppId', () => {
  it('allows a missing header (recorded as null)', () => {
    expect(parseAppId(undefined)).toEqual({ ok: true, appId: null });
    expect(parseAppId(null)).toEqual({ ok: true, appId: null });
    expect(parseAppId('   ')).toEqual({ ok: true, appId: null });
  });

  it.each(['my-dapp', 'a', 'drive.bosphor', 'App_01', '9lives'])('accepts slug %s', (raw) => {
    const r = parseAppId(raw);
    expect(r).toEqual({ ok: true, appId: raw.toLowerCase() });
  });

  it('normalises case so one app counts once', () => {
    expect(parseAppId('MyApp')).toEqual({ ok: true, appId: 'myapp' });
  });

  it('takes the first value of a repeated header', () => {
    expect(parseAppId(['first', 'second'])).toEqual({ ok: true, appId: 'first' });
  });

  it.each([
    '-leading-dash',
    '.dot',
    'has space',
    'emoji\u{1F600}',
    'semi;colon',
    'a'.repeat(65),
    '<script>',
  ])('rejects malformed id %s', (raw) => {
    const r = parseAppId(raw);
    expect(r.ok).toBe(false);
  });

  it('accepts exactly 64 characters', () => {
    expect(parseAppId('a'.repeat(64)).ok).toBe(true);
  });
});
