/**
 * Storage-duration policy: how many Walrus epochs the relayer stores a blob for.
 *
 * The user commits a storage duration (`storageEpochs`) on the origin chain and
 * that value travels to Sui in the IntentReceived event. `execute_store` then
 * aborts with EInsufficientStorageEpochs unless the stored blob's end epoch
 * covers `current_epoch + committed_storage_epochs`, and the escrow was priced
 * for exactly that duration. So the relayer stores for the COMMITTED epochs,
 * not a global setting.
 *
 * Rules (pure, no I/O):
 *   - committed present and within the max  -> store for exactly that many epochs
 *     (a committed 0 is stored for the Walrus minimum of 1 epoch, which covers it).
 *   - committed above the max               -> reject. The relayer never silently
 *     shortens a commitment: a shorter store would either abort on-chain after the
 *     WAL was spent or deliver less than the user paid for. Rejecting before any
 *     spend lets the origin escrow refund on its deadline (never-lose-money).
 *   - committed absent (legacy row recorded before the epochs were persisted)
 *     -> fall back to the configured default (WALRUS_STORE_EPOCHS). The caller
 *     logs this so the fallback is visible.
 */

/** Walrus rejects a zero-epoch store; one epoch is the smallest valid duration. */
export const WALRUS_MIN_EPOCHS = 1;

export interface StoreEpochsPolicy {
  /** Legacy fallback when the commitment carries no epochs (WALRUS_STORE_EPOCHS). */
  defaultEpochs: number;
  /** Largest duration the relayer will store for (min of WALRUS_MAX_EPOCHS and Walrus's own cap). */
  maxEpochs: number;
}

export type StoreEpochsResolution =
  | { ok: true; epochs: number; source: 'committed' | 'legacy_default' }
  | { ok: false; reason: string };

export function resolveStoreEpochs(
  committed: number | null | undefined,
  policy: StoreEpochsPolicy,
): StoreEpochsResolution {
  if (committed === null || committed === undefined) {
    if (policy.defaultEpochs > policy.maxEpochs) {
      return {
        ok: false,
        reason:
          `legacy default storage epochs ${policy.defaultEpochs} exceed the max ` +
          `${policy.maxEpochs}`,
      };
    }
    return { ok: true, epochs: policy.defaultEpochs, source: 'legacy_default' };
  }
  if (!Number.isInteger(committed) || committed < 0) {
    return { ok: false, reason: `invalid committed storage epochs ${committed}` };
  }
  if (committed > policy.maxEpochs) {
    return {
      ok: false,
      reason:
        `committed storage epochs ${committed} exceed the max storable ` +
        `${policy.maxEpochs}; refusing to store a shorter duration`,
    };
  }
  return { ok: true, epochs: Math.max(committed, WALRUS_MIN_EPOCHS), source: 'committed' };
}
