import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

// express ships with @nestjs/platform-express but has no bundled types here.
// Only express.raw() is needed (the raw-body parser for the ingest route), so
// require it with a minimal local signature instead of pulling in @types/express.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const express: { raw(opts: unknown): unknown } = require('express');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The public API is read-only; allow the dashboard origin to read it.
  const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? 'https://status.bosphor.xyz';
  app.enableCors({ origin: dashboardOrigin, methods: ['GET'] });

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
  logger.log(`Public API CORS origin: ${dashboardOrigin}`);
}

bootstrap();
