import { WaitlistAddResult, WaitlistEntry } from './waitlist.types';

/**
 * Persistence port for the developer waitlist. Kept small on purpose: callers
 * add an email, read the count (for a public tile), or export the full list (for
 * evidence). Implementations normalize the email as the dedupe key and own
 * idempotency.
 *
 * Real data only: on a backing-store failure, implementations throw so the API
 * surfaces an explicit error state rather than a fabricated success.
 */
export abstract class WaitlistStore {
  /** Register `email`. Idempotent: a duplicate returns `{ created: false }`. */
  abstract add(email: string, source?: string): Promise<WaitlistAddResult>;

  /** All registrations, oldest-first, for export. */
  abstract list(): Promise<WaitlistEntry[]>;

  /** Number of unique registrations. */
  abstract count(): Promise<number>;
}
