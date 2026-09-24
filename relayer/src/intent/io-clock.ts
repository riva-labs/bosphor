/**
 * Accumulates the wall time spent waiting on EXTERNAL blocking I/O during one
 * intent's store pipeline: chain RPC round-trips (Sui execute_store + wait, LZ
 * quote + send, EVM/Solana confirm), the Walrus upload-relay, WAL top-ups,
 * escrow reads, and live price fetches.
 *
 * The relayer's own COMPUTE latency (the M4 <3s KPI) is the store span MINUS
 * this accumulated I/O. Local Postgres queue writes are deliberately NOT counted
 * as external I/O: they run on the relayer's own machine and are part of its
 * processing overhead, so leaving them in keeps the compute figure conservative
 * (it can only over-report, never flatter the KPI).
 *
 * Any external call left unwrapped simply counts toward compute, so the metric
 * is honest by construction: forgetting to wrap a call makes compute look worse,
 * never better.
 */
export class IoClock {
  private ms = 0;

  /** Time an awaited external I/O call and add its duration to the total. */
  async time<T>(fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      this.ms += Date.now() - t0;
    }
  }

  /** Total external-I/O wall time accumulated so far, in milliseconds. */
  get totalMs(): number {
    return this.ms;
  }
}
