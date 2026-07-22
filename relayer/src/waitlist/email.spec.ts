import { isValidEmail, normalizeEmail } from './email';

describe('email helpers', () => {
  it('normalizes by trimming and lowercasing', () => {
    expect(normalizeEmail('  Dev@Bosphor.XYZ ')).toBe('dev@bosphor.xyz');
  });

  it('accepts a plausible address', () => {
    expect(isValidEmail('dev@bosphor.xyz')).toBe(true);
    expect(isValidEmail('a.b+tag@sub.example.co')).toBe(true);
  });

  it('rejects malformed or empty addresses', () => {
    for (const bad of ['', 'nope', 'no@domain', 'a b@c.d', '@bosphor.xyz', 'dev@']) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });

  it('rejects an over-long address', () => {
    const huge = `${'a'.repeat(250)}@x.io`;
    expect(isValidEmail(huge)).toBe(false);
  });
});
