import {
  BadRequestException,
  ConflictException,
  Controller,
  GoneException,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { IntentIngest } from './intent-ingest.service';
import { IngestRejectReason } from './intent-ingest.types';

/** Minimal shape of the raw-body request we rely on (populated by express.raw). */
interface RawBodyRequest {
  body?: Buffer;
}

interface IngestAck {
  intentId: string;
  blobId: string;
  size: number;
}

/**
 * Out-of-band blob ingest, shaped like the Walrus publisher's PUT /v1/blobs:
 * the client sends the raw blob bytes as the request body. The controller binds
 * them to the on-chain commitment via IntentIngest and returns a small JSON ack
 * on accept, or a precise 4xx per rejection reason.
 *
 * The raw binary body is provided by an express.raw() body parser scoped to
 * this route in main.ts, so req.body is a Buffer here (Nest's default JSON
 * parser is bypassed for /blob).
 */
@Controller('blob')
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(private readonly ingest: IntentIngest) {}

  @Post(':intentId')
  async ingestBlob(
    @Param('intentId') intentId: string,
    @Req() req: RawBodyRequest,
  ): Promise<IngestAck> {
    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new BadRequestException('request body must be the raw blob bytes');
    }

    const result = await this.ingest.ingest(intentId, bytes);
    if (result.ok) {
      return { intentId: result.intentId, blobId: result.blobId, size: result.size };
    }

    throw this.toHttpError(result.reason, result.message);
  }

  /** Map a typed ingest rejection to a precise HTTP error. */
  private toHttpError(reason: IngestRejectReason, message: string): HttpException {
    switch (reason) {
      case 'unknown':
        return new NotFoundException(message); // 404
      case 'already-executed':
        return new ConflictException(message); // 409
      case 'expired':
        return new GoneException(message); // 410
      case 'oversized':
        // 413 has no dedicated Nest exception; build it explicitly.
        return new HttpException(message, HttpStatus.PAYLOAD_TOO_LARGE); // 413
      case 'wrong-size':
      case 'wrong-blob-id':
        return new UnprocessableEntityException(message); // 422
    }
  }
}
