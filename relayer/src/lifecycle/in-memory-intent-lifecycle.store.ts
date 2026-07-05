import { Injectable } from '@nestjs/common';
import { IntentLifecycleStore } from './intent-lifecycle.store';
import { HopDetails, IntentHop, IntentLifecycleRecord } from './intent-lifecycle.types';

/**
 * In-memory IntentLifecycleStore. A real, correct implementation used for unit
 * tests and local development (no Postgres required). Production uses
 * PgIntentLifecycleStore, which shares this exact interface.
 */
@Injectable()
export class InMemoryIntentLifecycleStore extends IntentLifecycleStore {
  private readonly records = new Map<string, IntentLifecycleRecord>();

  async recordHop(intentId: string, hop: IntentHop, details: HopDetails = {}): Promise<void> {
    const timestamp = details.timestamp ?? Date.now();
    const existing = this.records.get(intentId);

    const record: IntentLifecycleRecord = existing ?? {
      intentId,
      status: hop,
      hops: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const entry = { hop, timestamp, txHash: details.txHash };
    const existingHop = record.hops.find((h) => h.hop === hop);
    if (existingHop) {
      existingHop.timestamp = timestamp;
      existingHop.txHash = details.txHash;
    } else {
      record.hops.push(entry);
    }
    record.status = hop;
    record.updatedAt = timestamp;
    if (details.sender !== undefined) record.sender = details.sender;
    if (details.blobId !== undefined) record.blobId = details.blobId;
    if (details.suiObjectId !== undefined) record.suiObjectId = details.suiObjectId;
    if (details.endEpoch !== undefined) record.endEpoch = details.endEpoch;

    this.records.set(intentId, record);
  }

  async getRecentIntents(limit?: number): Promise<IntentLifecycleRecord[]> {
    const all = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
    return limit === undefined ? all : all.slice(0, limit);
  }
}
