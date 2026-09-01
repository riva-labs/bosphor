import { bumpFee, bumpFeeOverrides, isNonceConflictError } from './nonce-conflict';

describe('isNonceConflictError', () => {
  it('matches ethers REPLACEMENT_UNDERPRICED / NONCE_EXPIRED codes', () => {
    expect(isNonceConflictError({ code: 'REPLACEMENT_UNDERPRICED' })).toBe(true);
    expect(isNonceConflictError({ code: 'NONCE_EXPIRED' })).toBe(true);
  });

  it('matches by message when the code is absent', () => {
    expect(isNonceConflictError(new Error('replacement transaction underpriced'))).toBe(true);
    expect(isNonceConflictError(new Error('nonce too low'))).toBe(true);
  });

  it('follows the ethers wrapped cause chain', () => {
    const wrapped = Object.assign(new Error('outer'), {
      cause: { code: 'NONCE_EXPIRED' },
    });
    expect(isNonceConflictError(wrapped)).toBe(true);
  });

  it('does not match transient RPC errors or unrelated failures', () => {
    expect(isNonceConflictError(new Error('request timeout'))).toBe(false);
    expect(isNonceConflictError({ code: 'SERVER_ERROR' })).toBe(false);
    expect(isNonceConflictError(null)).toBe(false);
  });
});

describe('bumpFee', () => {
  it('bumps by at least the 10% replacement floor', () => {
    expect(bumpFee(100n)).toBeGreaterThanOrEqual(110n);
  });

  it('rounds up so small fees still clear the floor', () => {
    // 1 * 112 / 100 rounds down to 1 without the +denominator-1; ensure it does not.
    expect(bumpFee(1n)).toBeGreaterThanOrEqual(2n);
  });

  it('bumps both legs of an EIP-1559 pair', () => {
    const bumped = bumpFeeOverrides({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n });
    expect(bumped.maxFeePerGas).toBeGreaterThanOrEqual(110n);
    expect(bumped.maxPriorityFeePerGas).toBeGreaterThanOrEqual(11n);
  });
});
