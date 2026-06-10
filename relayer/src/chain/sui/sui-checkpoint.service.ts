import { Injectable, Logger } from '@nestjs/common';
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { SuiService, SuiLzEvent } from './sui.service';
import { CURSOR_FILE_NAME, MAX_BACKOFF_MS } from '../../common/constants';

const CURSOR_FILE = resolve(__dirname, '../../../', CURSOR_FILE_NAME);

@Injectable()
export class SuiCheckpointService {
  private readonly logger = new Logger(SuiCheckpointService.name);
  private onEventCallback?: (event: SuiLzEvent) => Promise<void>;
  private stopped = false;

  constructor(private readonly sui: SuiService) {}

  /**
   * Register a callback for IntentReceived events detected via checkpoint streaming.
   */
  setOnEventCallback(cb: (event: SuiLzEvent) => Promise<void>) {
    this.onEventCallback = cb;
  }

  /**
   * Start the checkpoint stream. Called by IntentProcessor after the event
   * callback is registered, avoiding a race where backfill events arrive
   * before the callback is set.
   */
  startStreaming() {
    if (!this.sui.getLzPackageId()) return;
    this.startCheckpointStream().catch((err) =>
      this.logger.error(`Checkpoint stream fatal error: ${err}`),
    );
  }

  /**
   * Stop the checkpoint stream gracefully.
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

  private async startCheckpointStream() {
    const lastCheckpoint = this.readCursor();
    if (lastCheckpoint !== null) {
      this.logger.log(`Resuming from checkpoint ${lastCheckpoint}`);
      await this.backfill(lastCheckpoint);
    }

    let backoffMs = 1000;
    while (!this.stopped) {
      try {
        this.logger.log('Starting checkpoint stream...');
        await this.streamCheckpoints();
        backoffMs = 1000; // reset on clean disconnect
      } catch (err) {
        if (this.stopped) break;
        this.logger.warn(`Checkpoint stream error: ${err}. Reconnecting in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  private async backfill(fromCheckpoint: bigint) {
    const client = this.sui.getClient();
    const currentStr = await this.sui.getCheckpoint();
    const current = BigInt(currentStr);
    if (fromCheckpoint >= current) return;

    this.logger.log(`Backfilling checkpoints ${fromCheckpoint + 1n} to ${current}`);
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

  private async streamCheckpoints() {
    const client = this.sui.getClient();
    const stream = client.subscriptionService.subscribeCheckpoints({
      readMask: { paths: ['transactions.events'] },
    });

    for await (const msg of stream.responses) {
      if (this.stopped) break;
      const checkpoint = msg.checkpoint;
      const seq = BigInt(msg.cursor ?? checkpoint?.sequenceNumber ?? 0);
      if (checkpoint) {
        await this.processCheckpoint(checkpoint, seq);
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

        const json = event.json?.value;
        if (!json) continue;

        let fields: Record<string, any>;
        try {
          fields = typeof json === 'string' ? JSON.parse(json) : json;
        } catch {
          continue;
        }

        const intentIdBytes: number[] = fields.intent_id;
        if (!Array.isArray(intentIdBytes)) continue;
        const intentId =
          '0x' + intentIdBytes.map((b: number) => b.toString(16).padStart(2, '0')).join('');

        const lzEvent: SuiLzEvent = {
          intentId,
          payload: fields.payload,
          srcEid: fields.src_eid,
          nonce: BigInt(fields.nonce ?? 0),
        };

        if (this.onEventCallback) {
          await this.onEventCallback(lzEvent);
        }
      }
    }

    this.writeCursor(sequenceNumber);
  }
}
