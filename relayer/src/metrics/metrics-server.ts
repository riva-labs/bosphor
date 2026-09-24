import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

/** The slice of MetricsService the scrape server needs. */
export interface MetricsSource {
  readonly contentType: string;
  getMetrics(): Promise<string>;
}

export interface MetricsServerOptions {
  port: number;
  /** Bind address. 0.0.0.0 so Prometheus can reach it over the compose network. */
  host?: string;
  /**
   * Optional bearer token. When set, a scrape must send
   * `Authorization: Bearer <token>`; defence in depth if the port is ever
   * published beyond the internal network.
   */
  token?: string;
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(header ?? '');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/**
 * Serve Prometheus metrics on a dedicated internal port, separate from the
 * public API. The public port (api.bosphor.xyz) never answers /metrics, because
 * the exposition includes wallet balances and queue internals.
 *
 * Only `GET /metrics` is answered; everything else is a 404.
 */
export function startMetricsServer(
  source: MetricsSource,
  opts: MetricsServerOptions,
): Promise<Server> {
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const path = (req.url ?? '').split('?')[0];
    if (req.method !== 'GET' || path !== '/metrics') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    if (opts.token && !tokenMatches(req.headers.authorization, opts.token)) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer');
      res.end('unauthorized');
      return;
    }
    try {
      const body = await source.getMetrics();
      res.statusCode = 200;
      res.setHeader('Content-Type', source.contentType);
      res.end(body);
    } catch (err) {
      res.statusCode = 500;
      res.end(`metrics collection failed: ${err}`);
    }
  };

  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '0.0.0.0', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
