import { HopDetails, IntentHop, IntentLifecycleRecord } from './intent-lifecycle.types';

/**
 * Persistence port for the public intent feed. Kept deliberately small: callers
 * only ever record a hop or read the recent feed. Implementations own the
 * assembly of per-intent, per-hop records (see InMemoryIntentLifecycleStore and
 * PgIntentLifecycleStore).
 *
 * Real data only: on a backing-store failure, implementations throw so the API
 * can surface an explicit error state rather than a fabricated feed.
 */
export abstract class IntentLifecycleStore {
  /**
   * Idempotently record that `intentId` reached `hop`. The first hop creates the
   * intent; later hops merge onto the same record.
   */
  abstract recordHop(intentId: string, hop: IntentHop, details?: HopDetails): Promise<void>;

  /** Recent intents, newest-first. */
  abstract getRecentIntents(limit?: number): Promise<IntentLifecycleRecord[]>;
}
