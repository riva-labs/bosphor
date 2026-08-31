import { isTransientRpcError } from './transient-rpc-error';

describe('isTransientRpcError', () => {
  it('flags ethers SERVER_ERROR (public RPC 520)', () => {
    const err = Object.assign(new Error('server response 520 <none>'), { code: 'SERVER_ERROR' });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it('flags ethers TIMEOUT', () => {
    const err = Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });
    expect(isTransientRpcError(err)).toBe(true);
  });

  it('flags NETWORK_ERROR', () => {
    expect(isTransientRpcError(Object.assign(new Error('down'), { code: 'NETWORK_ERROR' }))).toBe(
      true,
    );
  });

  it('flags by message when no code is present', () => {
    expect(isTransientRpcError(new Error('request timeout (version=6.16.0)'))).toBe(true);
    expect(isTransientRpcError(new Error('error code: 520'))).toBe(true);
    expect(isTransientRpcError(new Error('socket hang up'))).toBe(true);
  });

  it('flags the ethers initial-network-discovery bootstrap failure', () => {
    // The exact shape ethers emits when the startup eth_chainId probe times
    // out: a NETWORK_ERROR wrapping the underlying request timeout.
    const timeout = Object.assign(new Error('request timeout (request={ ... })'), {
      code: 'TIMEOUT',
    });
    const bootstrap = Object.assign(
      new Error('failed to bootstrap network detection (event="initial-network-discovery")'),
      { code: 'NETWORK_ERROR', info: { error: timeout } },
    );
    expect(isTransientRpcError(bootstrap)).toBe(true);
    // Message alone must be enough if the code is stripped by re-wrapping.
    expect(isTransientRpcError(new Error('failed to bootstrap network detection'))).toBe(true);
  });

  it('follows the wrapped ethers .cause chain', () => {
    const cause = Object.assign(new Error('boom'), { code: 'TIMEOUT' });
    const wrapper = Object.assign(new Error('outer'), { cause });
    expect(isTransientRpcError(wrapper)).toBe(true);
  });

  it('does NOT flag real application errors', () => {
    expect(isTransientRpcError(new Error('MoveAbort in 9th command, abort code: 2'))).toBe(false);
    expect(isTransientRpcError(new Error('Failed to parse LZ fee quote'))).toBe(false);
    expect(isTransientRpcError(Object.assign(new Error('bad'), { code: 'CALL_EXCEPTION' }))).toBe(
      false,
    );
  });

  it('handles null / undefined / non-objects safely', () => {
    expect(isTransientRpcError(null)).toBe(false);
    expect(isTransientRpcError(undefined)).toBe(false);
    expect(isTransientRpcError('timeout')).toBe(false);
  });

  it('does not loop forever on a self-referential cause', () => {
    const err: { message: string; cause?: unknown } = { message: 'x' };
    err.cause = err;
    expect(isTransientRpcError(err)).toBe(false);
  });
});
