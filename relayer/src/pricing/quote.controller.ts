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

const ORIGIN_TOKENS: readonly OriginToken[] = ['ETH', 'SOL'];

/** Parse an optional decimal-string bigint field, or reject it with a 400. */
function decimalBigint(field: string, v: unknown): bigint | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) {
    throw new BadRequestException(`${field} must be a non-negative decimal integer string`);
  }
  return BigInt(v);
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
    // A malformed body is the caller's mistake: answer 400 with the reason, never
    // let it surface as a 500 from deeper in the pricing stack.
    const body = (dto ?? {}) as Partial<QuoteRequestDto>;
    if (!Number.isSafeInteger(body.sizeBytes) || (body.sizeBytes as number) < 0) {
      throw new BadRequestException('sizeBytes must be a non-negative integer');
    }
    if (!ORIGIN_TOKENS.includes(body.originToken as OriginToken)) {
      throw new BadRequestException(`originToken must be one of ${ORIGIN_TOKENS.join(', ')}`);
    }
    const q = await this.quote.quote({
      sizeBytes: body.sizeBytes as number,
      epochs: body.epochs,
      originToken: body.originToken as OriginToken,
      forwardLzFeeNative: decimalBigint('forwardLzFeeNative', body.forwardLzFeeNative),
      originGasNative: decimalBigint('originGasNative', body.originGasNative),
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
