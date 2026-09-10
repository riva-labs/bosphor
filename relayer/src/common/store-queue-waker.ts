import { Injectable } from '@nestjs/common';

/**
 * A tiny in-process wake signal for the durable store queue.
 *
 * The store pipeline drains on a fixed poll interval (a latency floor of up to
 * one interval). This lets the two events that make a row ready - the Sui
 * IntentReceived and a byte ingest - nudge the drain to run promptly instead of
 * waiting out the poll. It carries no data and never replaces the poll: the poll
 * remains the durability backstop (a missed or dropped wake is still picked up on
 * the next tick), so the queue's idempotency, dead-lettering, and recovery are
 * untouched. Decoupling producers (ingest, receive) from the consumer (processor)
 * via this signal avoids a circular dependency between them.
 */
@Injectable()
export class StoreQueueWaker {
  private listeners: Array<() => void> = [];

  /** Register a consumer to be nudged on wake. Returns an unsubscribe function. */
  onWake(listener: () => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Signal that the queue may have newly-ready work. Never throws. */
  wake(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        // A listener fault must not break the producer that woke us; the poll
        // still guarantees the work is eventually drained.
      }
    }
  }
}
