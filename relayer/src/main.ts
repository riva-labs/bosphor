import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // The public API is read-only; allow the dashboard origin to read it.
  const dashboardOrigin = process.env.DASHBOARD_ORIGIN ?? 'https://status.bosphor.xyz';
  app.enableCors({ origin: dashboardOrigin, methods: ['GET'] });

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Bosphor Relayer listening on port ${port}`);
  logger.log(`Public API CORS origin: ${dashboardOrigin}`);
}

bootstrap();
