import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { buildCorsOptions } from './api/cors-config';
import { createRateLimitMiddleware } from './api/rate-limit';
import { MetricsService } from './metrics/metrics.service';

// express ships with @nestjs/platform-express but has no bundled types here.
// Only express.raw() is needed (the raw-body parser for the ingest route), so
// require it with a minimal local signature instead of pulling in @types/express.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const express: { raw(opts: unknown): unknown } = require('express');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Browser dApps call the integrator API (POST /blob/:intentId, /blob/encode,
  // /quote) directly, so preflight + POST must pass for the configured origins.
  // CORS_ORIGINS='*' (default) opens it; an explicit list always keeps the
  // dashboard origin that reads the public feed.
  const cors = buildCorsOptions({
    corsOrigins: config.get<string>('CORS_ORIGINS'),
    dashboardOrigin: config.get<string>('DASHBOARD_ORIGIN'),
  });
  app.enableCors(cors);

  // Per-IP (and per-app) rate limits on the integrator routes. Registered BEFORE
  // the raw-body parser below, so an over-limit client is turned away with a 429
  // before the relayer reads (up to 10 MiB of) its body.
  const metrics = app.get(MetricsService);
  const trustProxy = config.get<boolean>('TRUST_PROXY') ?? false;
  app.use(
    ['/blob', '/quote'],
    createRateLimitMiddleware(
      {
        enabled: config.get<boolean>('RATE_LIMIT_ENABLED') ?? true,
        windowMs: config.get<number>('RATE_LIMIT_WINDOW_MS') ?? 60_000,
        perIp: config.get<number>('RATE_LIMIT_PER_IP') ?? 120,
        perApp: config.get<number>('RATE_LIMIT_PER_APP') ?? 1200,
        encodePerIp: config.get<number>('RATE_LIMIT_ENCODE_PER_IP') ?? 30,
        trustProxy,
      },
      { onLimited: (scope) => metrics.recordRateLimited(scope) },
    ),
  );

  // The out-of-band ingest endpoint (POST /blob/:intentId) accepts the raw blob
  // bytes as the request body, shaped like the Walrus publisher's PUT /v1/blobs.
  // Scope express.raw() to /blob so Nest's default JSON parser is bypassed there
  // and the controller receives req.body as a Buffer. The cap is generous; the
  // exact MAX_INGEST_BLOB_BYTES enforcement lives in IntentIngest so the reason
  // ("oversized") is a typed 413 rather than a parser-level error.
  const rawBodyLimit = Number(process.env.MAX_INGEST_BLOB_BYTES ?? 10_485_760) + 1024;
  app.use('/blob', express.raw({ type: () => true, limit: rawBodyLimit }));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Bosphor Relayer listening on port ${port}`);
  logger.log(`API CORS origins: ${cors.origin === '*' ? '*' : cors.origin.join(', ')}`);
}

bootstrap();
