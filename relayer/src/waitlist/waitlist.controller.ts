import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isValidEmail, normalizeEmail } from './email';
import { WaitlistStore } from './waitlist.store';
import { WaitlistEntry } from './waitlist.types';

interface JoinBody {
  email?: string;
  source?: string;
}

/**
 * Public waitlist API backing the adoption-signal CTA. `POST /public/waitlist`
 * is open (that is the signup). `GET /public/waitlist/count` is public for a
 * "N developers waitlisted" tile. `GET /public/waitlist/export` is gated behind
 * a bearer token so registrations are not publicly enumerable. CORS is
 * restricted to the dashboard origin in main.ts.
 *
 * Real data only: store failures surface as an explicit 503, never a fabricated
 * success or count.
 */
@Controller('public')
export class WaitlistController {
  private readonly logger = new Logger(WaitlistController.name);

  constructor(
    private readonly store: WaitlistStore,
    private readonly config: ConfigService,
  ) {}

  @Post('waitlist')
  @HttpCode(200)
  async join(@Body() body: JoinBody): Promise<{ ok: true; created: boolean }> {
    const email = normalizeEmail(body?.email ?? '');
    if (!isValidEmail(email)) {
      throw new BadRequestException('a valid email is required');
    }
    const source = typeof body?.source === 'string' ? body.source.slice(0, 64) : undefined;
    try {
      const { created } = await this.store.add(email, source);
      return { ok: true, created };
    } catch (err) {
      this.logger.error(`Failed to record waitlist signup: ${err}`);
      throw new ServiceUnavailableException('waitlist temporarily unavailable');
    }
  }

  @Get('waitlist/count')
  async count(): Promise<{ count: number }> {
    try {
      return { count: await this.store.count() };
    } catch (err) {
      this.logger.error(`Failed to read waitlist count: ${err}`);
      throw new ServiceUnavailableException('waitlist temporarily unavailable');
    }
  }

  @Get('waitlist/export')
  async export(
    @Headers('authorization') auth?: string,
  ): Promise<{ entries: WaitlistEntry[]; count: number }> {
    const token = this.config.get<string>('WAITLIST_EXPORT_TOKEN');
    if (!token) {
      throw new ForbiddenException('export is disabled (WAITLIST_EXPORT_TOKEN not set)');
    }
    if (auth !== `Bearer ${token}`) {
      throw new UnauthorizedException('invalid export token');
    }
    try {
      const entries = await this.store.list();
      return { entries, count: entries.length };
    } catch (err) {
      this.logger.error(`Failed to export waitlist: ${err}`);
      throw new ServiceUnavailableException('waitlist temporarily unavailable');
    }
  }
}
