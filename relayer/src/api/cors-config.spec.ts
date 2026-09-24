import { buildCorsOptions, parseCorsOrigins } from './cors-config';

describe('parseCorsOrigins', () => {
  it('splits, trims and drops trailing slashes and blanks', () => {
    expect(parseCorsOrigins(' https://a.xyz/ , ,https://b.xyz')).toEqual([
      'https://a.xyz',
      'https://b.xyz',
    ]);
  });

  it('returns an empty list for an unset value', () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins('')).toEqual([]);
  });
});

describe('buildCorsOptions', () => {
  it('defaults to any origin so browser dApps can integrate', () => {
    const opts = buildCorsOptions({ dashboardOrigin: 'https://status.bosphor.xyz' });
    expect(opts.origin).toBe('*');
  });

  it('treats "*" anywhere in the list as a wildcard', () => {
    expect(buildCorsOptions({ corsOrigins: 'https://a.xyz,*' }).origin).toBe('*');
  });

  it('allows POST, GET and OPTIONS and the app id header', () => {
    const opts = buildCorsOptions({ corsOrigins: '*' });
    expect(opts.methods).toEqual(expect.arrayContaining(['GET', 'POST', 'OPTIONS']));
    expect(opts.allowedHeaders).toEqual(expect.arrayContaining(['Content-Type', 'X-Bosphor-App']));
    expect(opts.exposedHeaders).toContain('Retry-After');
  });

  it('keeps the dashboard origin working with an explicit allowlist', () => {
    const opts = buildCorsOptions({
      corsOrigins: 'https://demo.bosphor.xyz',
      dashboardOrigin: 'https://status.bosphor.xyz/',
    });
    expect(opts.origin).toEqual(['https://demo.bosphor.xyz', 'https://status.bosphor.xyz']);
  });

  it('does not duplicate a dashboard origin that is already listed', () => {
    const opts = buildCorsOptions({
      corsOrigins: 'https://status.bosphor.xyz',
      dashboardOrigin: 'https://status.bosphor.xyz',
    });
    expect(opts.origin).toEqual(['https://status.bosphor.xyz']);
  });
});
