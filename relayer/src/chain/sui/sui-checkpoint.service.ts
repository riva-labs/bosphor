import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { SuiService, SuiLzEvent } from './sui.service';
import { MetricsService } from '../../metrics/metrics.service';
import { CURSOR_FILE_NAME, MAX_BACKOFF_MS, POLL_INTERVAL_MS } from '../../common/constants';

const CURSOR_FILE = resolve(__dirname, '../../../', CURSOR_FILE_NAME);

@Injectable()
export class SuiCheckpointService {
  private readonly logger = new Logger(SuiCheckpointService.name);
  private onEventCallback?: (event: SuiLzEvent) => Promise<void>;
  private stopped = false;

  constructor(
    private readonly sui: SuiService,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Register a callback for IntentReceived events detected via checkpoint streaming.
   */
  setOnEventCallback(cb: (event: SuiLzEvent) => Promise<void>) {
    this.onEventCallback = cb;
  }

  /**
   * Start polling Sui checkpoints for IntentReceived events. Called by
   * IntentProcessor after the event callback is registered, avoiding a race
   * where backfilled events arrive before the callback is set.
   */
  startStreaming() {
    if (!this.sui.getLzPackageId()) return;
    this.runCheckpointPoll().catch((err) =>
      this.logger.error(`Checkpoint poll fatal error: ${err}`),
    );
  }

  /**
   * Stop the checkpoint poll gracefully.
   */
  stop() {
    this.stopped = true;
  }

  private readCursor(): bigint | null {
    try {
      const data = readFileSync(CURSOR_FILE, 'utf-8').trim();
      return BigInt(data);
    } catch {
      return null;
    }
  }

  private writeCursor(checkpoint: bigint) {
    writeFileSync(CURSOR_FILE, checkpoint.toString());
  }

  /**
   * Poll Sui for new checkpoints and process their events on a fixed interval.
   *
   * Detection is driven by sequential backfill from the cursor rather than the
   * live `subscribeCheckpoints` stream. The stream drops roughly every minute
   * and resubscribes from the latest checkpoint, silently skipping events
   * produced during the gap while still advancing the high-water cursor past
   * them, so events are lost and never recovered. Sequential backfill visits
   * every checkpoint in order, so no IntentReceived event is missed.
   */
  private async runCheckpointPoll() {
    // Start from the current checkpoint on first run so we process intents from
    // now forward instead of replaying all of chain history.
    if (this.readCursor() === null) {
      const current = BigInt(await this.sui.getCheckpoint());
      this.writeCursor(current);
      this.logger.log(`Initialized checkpoint cursor at ${current}`);
    } else {
      this.logger.log(`Resuming from checkpoint ${this.readCursor()}`);
    }

    let backoffMs = 1000;
    while (!this.stopped) {
      try {
        const cursor = this.readCursor();
        if (cursor !== null) {
          await this.backfill(cursor);
        }
        backoffMs = 1000; // reset after a clean pass
        await this.sleep(POLL_INTERVAL_MS);
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn(`Checkpoint poll error: ${err}. Retrying in ${backoffMs}ms...`);
        await this.sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async backfill(fromCheckpoint: bigint) {
    const client = this.sui.getClient();
    const current = BigInt(await this.sui.getCheckpoint());
    this.metrics.setCheckpointCursorLag(Number(current > fromCheckpoint ? current - fromCheckpoint : 0n));
    if (fromCheckpoint >= current) return;

    // Only announce sizeable catch-ups; steady-state polling advances a handful
    // of checkpoints per pass and would otherwise spam the log.
    if (current - fromCheckpoint > 50n) {
      this.logger.log(`Backfilling checkpoints ${fromCheckpoint + 1n} to ${current}`);
    }
    for (let seq = fromCheckpoint + 1n; seq <= current; seq++) {
      if (this.stopped) break;
      const { response } = await client.ledgerService.getCheckpoint({
        checkpointId: { oneofKind: 'sequenceNumber' as const, sequenceNumber: seq },
        readMask: { paths: ['transactions.events'] },
      });
      if (response.checkpoint) {
        await this.processCheckpoint(response.checkpoint, seq);
      }
    }
  }

  async processCheckpoint(checkpoint: any, sequenceNumber: bigint) {
    const lzPackageId = this.sui.getLzPackageId();
    const eventType = `${lzPackageId}::lz_receiver::IntentReceived`;
    const transactions = checkpoint.transactions ?? [];

    for (const tx of Array.isArray(transactions) ? transactions : [transactions]) {
      const eventsContainer = tx.events;
      if (!eventsContainer) continue;

      const events = eventsContainer.events ?? [];
      for (const event of events) {
        if (event.eventType !== eventType) continue;

        // gRPC returns event.json as a protobuf Value:
        //   { kind: { structValue: { fields: { <name>: Value, ... } } } }
        // where each field is itself a Value with a `kind` oneof. Byte vectors
        // (intent_id, payload) arrive base64-encoded as stringValue, u32 as
        // numberValue, and u64 (nonce) as stringValue.
        const structFields = event.json?.kind?.structValue?.fields;
        if (!structFields) continue;

        const strVal = (f: any): string | undefined => f?.kind?.stringValue;
        const numVal = (f: any): number | undefined => f?.kind?.numberValue;
        const b64Bytes = (s?: string): number[] =>
          s ? Array.from(new Uint8Array(Buffer.from(s, 'base64'))) : [];

        const intentIdBytes = b64Bytes(strVal(structFields.intent_id));
        if (intentIdBytes.length === 0) continue;
        const intentId =
          '0x' + intentIdBytes.map((b) => b.toString(16).padStart(2, '0')).join('');

        const lzEvent: SuiLzEvent = {
          intentId,
          payload: b64Bytes(strVal(structFields.payload)),
          srcEid: numVal(structFields.src_eid) ?? 0,
          nonce: BigInt(strVal(structFields.nonce) ?? '0'),
        };

        if (this.onEventCallback) {
          await this.onEventCallback(lzEvent);
        }
      }
    }

    this.writeCursor(sequenceNumber);
  }
}
