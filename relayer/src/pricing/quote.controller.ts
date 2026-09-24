import { BadRequestException, Body, Controller, Headers, Post } from '@nestjs/common';
import { APP_ID_HEADER, parseAppId } from '../api/app-id';
import { OriginToken } from './quote-engine';
import { QuoteService } from './quote.service';

interface QuoteRequestDto {
  sizeBytes: number;
  epochs?: number;
  originToken: OriginToken;
  /** Decimal strings to preserve full bigint precision over the wire. */
  forwardLzFeeNative?: string;
  originGasNative?: string;
}

/**
 * Relayer quote endpoint. Bigints are carried as decimal strings so no precision
 * is lost over JSON. This is the single pricing source of truth the SDK calls.
 */
@Controller('quote')
export class QuoteController {
  constructor(private readonly quote: QuoteService) {}

  @Post()
  async getQuote(
    @Body() dto: QuoteRequestDto,
    @Headers(APP_ID_HEADER.toLowerCase()) rawAppId?: string,
  ): Promise<Record<string, unknown>> {
    // The optional integrator id is validated here (a malformed one is a 400) and
    // used by the rate limiter for per-app budgets. A quote has no intent yet, so
    // provenance is recorded on ingest, where the intent id is known.
    const app = parseAppId(rawAppId);
    if (!app.ok) throw new BadRequestException(app.message);
    const q = await this.quote.quote({
      sizeBytes: dto.sizeBytes,
      epochs: dto.epochs,
      originToken: dto.originToken,
      forwardLzFeeNative: dto.forwardLzFeeNative ? BigInt(dto.forwardLzFeeNative) : undefined,
      originGasNative: dto.originGasNative ? BigInt(dto.originGasNative) : undefined,
    });

    return {
      originToken: q.originToken,
      escrowNative: q.escrowNative.toString(),
      forwardNative: q.forwardNative.toString(),
      totalNative: q.totalNative.toString(),
      breakdown: q.breakdown,
      prices: q.prices,
    };
  }
}
