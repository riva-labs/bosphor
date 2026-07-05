import { Injectable } from '@nestjs/common';
import { IntentLifecycleStore } from './intent-lifecycle.store';
import { applyHop } from './intent-lifecycle.merge';
import { HopDetails, IntentHop, IntentLifecycleRecord } from './intent-lifecycle.types';

/**
 * In-memory IntentLifecycleStore. A real, correct implementation used for unit
 * tests and local development (no Postgres required). Production uses
 * PgIntentLifecycleStore, which shares this exact interface and hop-merge logic.
 */
@Injectable()
export class InMemoryIntentLifecycleStore extends IntentLifecycleStore {
  private readonly records = new Map<string, IntentLifecycleRecord>();

  async recordHop(intentId: string, hop: IntentHop, details: HopDetails = {}): Promise<void> {
    const record = applyHop(this.records.get(intentId), intentId, hop, details, Date.now());
    this.records.set(intentId, record);
  }

  async getRecentIntents(limit?: number): Promise<IntentLifecycleRecord[]> {
    const all = [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
    return limit === undefined ? all : all.slice(0, limit);
  }
}
