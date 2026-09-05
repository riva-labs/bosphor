import { Body, Controller, Post } from '@nestjs/common';
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
  async getQuote(@Body() dto: QuoteRequestDto): Promise<Record<string, unknown>> {
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
