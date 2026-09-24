import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { startMetricsServer } from './metrics-server';
import { MetricsService } from './metrics.service';

describe('startMetricsServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((r) => server!.close(r));
    server = undefined;
  });

  async function start(token?: string): Promise<string> {
    server = await startMetricsServer(new MetricsService(), { port: 0, host: '127.0.0.1', token });
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it('serves the Prometheus exposition on GET /metrics', async () => {
    const base = await start();
    const res = await fetch(`${base}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('process_cpu_seconds_total');
  });

  it('answers nothing else (404)', async () => {
    const base = await start();
    expect((await fetch(`${base}/health`)).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST' })).status).toBe(404);
  });

  it('requires the bearer token when one is configured', async () => {
    const base = await start('s3cret');
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const wrong = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer wrong!' } });
    expect(wrong.status).toBe(401);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer s3cret' } });
    expect(ok.status).toBe(200);
  });
});
