import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';
import { configureHttp } from './api/http-setup';
import { MetricsService } from './metrics/metrics.service';
import { startMetricsServer } from './metrics/metrics-server';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const metrics = app.get(MetricsService);

  // CORS, integrator rate limits and the /blob raw-body parser (see http-setup).
  const { cors, trustProxy } = configureHttp(app, config, metrics);

  const port = Number(config.get<number>('PORT') ?? process.env.PORT ?? 3000);
  const metricsPort = config.get<number>('METRICS_PORT') ?? 9464;
  if (metricsPort === port) {
    // Serving metrics on the public port would leak wallet balances; refuse.
    throw new Error(`METRICS_PORT (${metricsPort}) must differ from the public PORT (${port})`);
  }

  await app.listen(port);
  const logger = new Logger('Bootstrap');
  logger.log(`Bosphor Relayer listening on port ${port}`);
  logger.log(`API CORS origins: ${cors.origin === '*' ? '*' : cors.origin.join(', ')}`);
  logger.log(
    `Rate limits: ${trustProxy ? 'client IP from proxy headers' : 'client IP from socket'}`,
  );

  // /metrics lives on its own internal port, never on the public API.
  const metricsHost = config.get<string>('METRICS_HOST') ?? '0.0.0.0';
  await startMetricsServer(metrics, {
    port: metricsPort,
    host: metricsHost,
    token: config.get<string>('METRICS_TOKEN') || undefined,
  });
  logger.log(`Prometheus metrics on ${metricsHost}:${metricsPort}/metrics (internal)`);
}

bootstrap();
