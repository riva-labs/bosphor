import { HopDetails, IntentHop, IntentLifecycleRecord } from './intent-lifecycle.types';

/**
 * Pure hop-merge: fold a new hop onto an intent's lifecycle record. The first
 * hop creates the record; later hops merge onto it. Recording the same hop
 * again updates its entry in place rather than duplicating. Shared by every
 * IntentLifecycleStore implementation so the assembly rules live in one place.
 */
export function applyHop(
  existing: IntentLifecycleRecord | undefined,
  intentId: string,
  hop: IntentHop,
  details: HopDetails,
  now: number,
): IntentLifecycleRecord {
  const timestamp = details.timestamp ?? now;

  const record: IntentLifecycleRecord = existing
    ? { ...existing, hops: existing.hops.map((h) => ({ ...h })) }
    : { intentId, status: hop, hops: [], createdAt: timestamp, updatedAt: timestamp };

  const existingHop = record.hops.find((h) => h.hop === hop);
  if (existingHop) {
    existingHop.timestamp = timestamp;
    existingHop.txHash = details.txHash;
  } else {
    record.hops.push({ hop, timestamp, txHash: details.txHash });
  }

  record.status = hop;
  record.updatedAt = timestamp;
  if (details.sender !== undefined) record.sender = details.sender;
  if (details.blobId !== undefined) record.blobId = details.blobId;
  if (details.suiObjectId !== undefined) record.suiObjectId = details.suiObjectId;
  if (details.endEpoch !== undefined) record.endEpoch = details.endEpoch;

  return record;
}
