import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SuiService } from '../chain/sui/sui.service';
import { IntentLifecycleStore } from '../lifecycle/intent-lifecycle.store';
import { StagedIntentStore } from '../staged/staged-intent.store';
import { IngestRejected, IngestResult } from './intent-ingest.types';
import { blobIdMatches } from '../common/walrus-blob-id';

/**
 * Binds out-of-band bytes to an on-chain commitment.
 *
 * M3 moved the blob data off the LayerZero message. The intent now carries only
 * a commitment (blob id + size + deadline, emitted by EVM IntentSubmitted); the
 * raw bytes reach the relayer out-of-band via the ingest endpoint. This service
 * is the gate: it proves the received bytes are exactly what the sender
 * committed to before any WAL is spent, then durably writes them to the store
 * queue (staged_intent) for the processor to store after IntentReceived fires.
 *
 * No upload happens here. The Walrus blob id is recomputed locally via the SDK's
 * encodeBlob, which derives the id without contacting the network.
 */
@Injectable()
export class IntentIngest {
  private readonly logger = new Logger(IntentIngest.name);
  private readonly maxIngestBytes: number;
  private readonly maxStagedBytes: number;

  constructor(
    private readonly config: ConfigService,
    private readonly sui: SuiService,
    private readonly lifecycle: IntentLifecycleStore,
    // The durable store queue, the sole sink for accepted bytes. Null when
    // DATABASE_URL is unset (local dev / tests): ingest then validates but has
    // nowhere durable to persist, and the processor is likewise inert. Explicit
    // @Inject token because the `| null` union erases DI type metadata.
    @Optional() @Inject(StagedIntentStore) private readonly staged: StagedIntentStore | null = null,
  ) {
    this.maxIngestBytes = this.config.get<number>('MAX_INGEST_BLOB_BYTES') ?? 10_485_760;
    this.maxStagedBytes = this.config.get<number>('MAX_STAGED_BYTES') ?? 268_435_456;
  }

  /**
   * Validate and buffer out-of-band bytes for `intentId`. Validation runs in a
   * fixed order, each failure returning a distinct typed reason:
   *   unknown -> already-executed -> expired -> oversized -> wrong-size -> wrong-blob-id.
   * On acceptance the bytes are durably written to the store queue (not uploaded)
   * keyed by intent id for the processor to store after IntentReceived.
   */
  async ingest(intentId: string, bytes: Buffer): Promise<IngestResult> {
    const commitment = await this.lifecycle.getCommitment(intentId);
    if (!commitment) {
      return this.reject(intentId, 'unknown', 'no pending intent for this id');
    }

    // An intent is "executed" once it has stored on Walrus or gone further. Re-
    // ingesting is a no-op the relayer must refuse rather than re-buffer.
    if (this.isExecuted(commitment.status)) {
      return this.reject(intentId, 'already-executed', 'intent already executed');
    }

    if (Date.now() > commitment.deadline) {
      return this.reject(intentId, 'expired', 'intent deadline has passed');
    }

    // Absolute cap first, before the exact-size check, so an oversized upload is
    // rejected with its own reason instead of being read as a size mismatch.
    if (bytes.length > this.maxIngestBytes) {
      return this.reject(
        intentId,
        'oversized',
        `blob exceeds MAX_INGEST_BLOB_BYTES (${bytes.length} > ${this.maxIngestBytes})`,
      );
    }

    if (bytes.length !== commitment.size) {
      return this.reject(
        intentId,
        'wrong-size',
        `blob size ${bytes.length} does not match committed size ${commitment.size}`,
      );
    }

    // Aggregate backpressure: shed load before the CPU-heavy blob-id recompute
    // (and before buffering) when the durable queue is already near its byte
    // ceiling. Sourced from a live SUM over staged rows, never an in-memory
    // counter (which drifts and is wrong across restart/multi-instance).
    if (this.staged) {
      const stagedBytes = await this.staged.stagedBytesTotal();
      if (stagedBytes + bytes.length > this.maxStagedBytes) {
        return this.reject(
          intentId,
          'backpressure',
          `staged bytes ${stagedBytes} + ${bytes.length} exceed MAX_STAGED_BYTES ${this.maxStagedBytes}`,
        );
      }
    }

    // Recompute the Walrus blob id locally (no upload) and require it to equal
    // the on-chain commitment. This is the load-bearing binding: it proves the
    // bytes are exactly what the sender paid to store.
    const walrusClient = this.sui.getWalrusClient();
    const { blobId } = await walrusClient.walrus.encodeBlob(new Uint8Array(bytes));
    if (!blobIdMatches(blobId, commitment.committedBlobId)) {
      return this.reject(
        intentId,
        'wrong-blob-id',
        `recomputed blob id ${blobId} does not match committed ${commitment.committedBlobId}`,
      );
    }

    // Durably write the accepted bytes to the store queue: the single source of
    // truth for pending stores, so an accepted upload survives a crash.
    await this.staged?.upsertBytes(intentId, { bytes, blobId, size: bytes.length });
    this.logger.log(
      `[${intentId}] Ingest accepted: ${bytes.length} bytes, blobId ${blobId} (staged for store)`,
    );
    return { ok: true, intentId, blobId, size: bytes.length };
  }

  /**
   * Derive the Walrus blob id from raw bytes without storing anything. This is
   * the same offline encoder the ingest path uses to verify the commitment,
   * exposed so a client can compute the blob id it must commit to on-chain
   * without depending on a public Walrus publisher. No WAL is spent and nothing
   * is written to Walrus or the queue.
   */
  async encode(bytes: Buffer): Promise<{ blobId: string; size: number }> {
    const walrusClient = this.sui.getWalrusClient();
    const { blobId } = await walrusClient.walrus.encodeBlob(new Uint8Array(bytes));
    return { blobId, size: bytes.length };
  }

  private isExecuted(status: string): boolean {
    // Any hop at or past stored_walrus means WAL was already spent for this id.
    return (
      status === 'stored_walrus' ||
      status === 'recorded_sui' ||
      status === 'proof_sent' ||
      status === 'confirmed'
    );
  }

  private reject(
    intentId: string,
    reason: IngestRejected['reason'],
    message: string,
  ): IngestRejected {
    this.logger.warn(`[${intentId}] Ingest rejected (${reason}): ${message}`);
    return { ok: false, intentId, reason, message };
  }
}

// Re-exported for existing importers. The implementation lives in
// common/walrus-blob-id so the ingest re-check, the return proof, and the client
// commitment all agree with on-chain `blob.blob_id()`.
export { blobIdMatches };
