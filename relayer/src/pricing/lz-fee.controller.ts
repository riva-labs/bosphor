import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  NotImplementedException,
  Query,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SolanaLzFeeService } from './solana-lz-fee.service';

/** Seconds a client should wait before asking again after a failed simulation. */
const RETRY_AFTER_SECONDS = 5;

/** The one response method this controller needs (typed structurally, no @types/express). */
interface ResponseLike {
  header(name: string, value: string): unknown;
}

/**
 * Live LayerZero fees the relayer computes server-side, so a browser does not
 * need a chain's heavy LayerZero SDK. Today: the Solana -> Sui forward leg.
 */
@Controller('lz-fee')
export class LzFeeController {
  private readonly logger = new Logger(LzFeeController.name);

  constructor(private readonly solana: SolanaLzFeeService) {}

  @Get('solana')
  async solanaFee(
    @Res({ passthrough: true }) res: ResponseLike,
    @Query('dstEid') rawDstEid?: string,
  ): Promise<Record<string, unknown>> {
    if (!this.solana.isEnabled()) {
      throw new NotImplementedException(
        'Solana LayerZero fee quoting is not enabled on this relayer',
      );
    }
    if (rawDstEid !== undefined && rawDstEid !== '') {
      const dstEid = Number(rawDstEid);
      if (!Number.isSafeInteger(dstEid) || dstEid !== this.solana.dstEid) {
        throw new BadRequestException(
          `dstEid ${rawDstEid} is not served: this relayer prices Solana -> ${this.solana.dstEid}`,
        );
      }
    }

    let q;
    try {
      q = await this.solana.quote();
    } catch (err) {
      // Fail loudly: no stale, default or estimated fee is ever returned.
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Solana LayerZero fee unavailable: ${reason}`);
      res.header('Retry-After', String(RETRY_AFTER_SECONDS));
      throw new ServiceUnavailableException(`live Solana LayerZero fee unavailable: ${reason}`);
    }
    return {
      srcEid: q.srcEid,
      dstEid: q.dstEid,
      nativeFee: q.nativeFee.toString(),
      quotedAt: q.quotedAtMs,
      maxAgeMs: q.maxAgeMs,
    };
  }
}
