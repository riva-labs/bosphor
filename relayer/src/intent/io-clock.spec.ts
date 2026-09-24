import { IoClock } from './io-clock';

describe('IoClock', () => {
  it('starts at zero', () => {
    expect(new IoClock().totalMs).toBe(0);
  });

  it('accumulates the duration of awaited I/O calls', async () => {
    const io = new IoClock();
    await io.time(() => new Promise((r) => setTimeout(r, 30)));
    await io.time(() => new Promise((r) => setTimeout(r, 20)));
    // Allow scheduler slack, but it must have measured both waits.
    expect(io.totalMs).toBeGreaterThanOrEqual(45);
  });

  it('returns the wrapped call result', async () => {
    const io = new IoClock();
    await expect(io.time(async () => 'digest')).resolves.toBe('digest');
  });

  it('still accounts time when the wrapped call rejects', async () => {
    const io = new IoClock();
    await expect(
      io.time(() => new Promise((_r, reject) => setTimeout(() => reject(new Error('rpc')), 20))),
    ).rejects.toThrow('rpc');
    expect(io.totalMs).toBeGreaterThanOrEqual(15);
  });

  it('leaves compute time (total span minus I/O) attributable to the caller', async () => {
    const io = new IoClock();
    const start = Date.now();
    await io.time(() => new Promise((r) => setTimeout(r, 25))); // external I/O
    await new Promise((r) => setTimeout(r, 15)); // relayer compute (not wrapped)
    const elapsed = Date.now() - start;
    const compute = elapsed - io.totalMs;
    // Compute is the unwrapped portion; it must be well under the total span.
    expect(compute).toBeGreaterThanOrEqual(5);
    expect(compute).toBeLessThan(elapsed);
  });
});
