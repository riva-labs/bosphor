import { Injectable } from '@nestjs/common';
import { normalizeEmail } from './email';
import { WaitlistStore } from './waitlist.store';
import { WaitlistAddResult, WaitlistEntry } from './waitlist.types';

/**
 * In-memory WaitlistStore. A real, correct implementation used for unit tests
 * and local development (no Postgres required). Production uses PgWaitlistStore,
 * which shares this exact interface and dedupe semantics.
 */
@Injectable()
export class InMemoryWaitlistStore extends WaitlistStore {
  private readonly entries = new Map<string, WaitlistEntry>();

  async add(email: string, source?: string): Promise<WaitlistAddResult> {
    const key = normalizeEmail(email);
    if (this.entries.has(key)) return { created: false };
    this.entries.set(key, { email: key, source, createdAt: Date.now() });
    return { created: true };
  }

  async list(): Promise<WaitlistEntry[]> {
    return [...this.entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async count(): Promise<number> {
    return this.entries.size;
  }
}
