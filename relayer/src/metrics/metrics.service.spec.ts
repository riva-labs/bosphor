import { MetricsService } from './metrics.service';

describe('MetricsService', () => {
  let service: MetricsService;

  beforeEach(() => {
    service = new MetricsService();
  });

  it('counts processed intents by path and result', async () => {
    service.recordIntentProcessed('evm', 'success');
    service.recordIntentProcessed('evm', 'success');
    service.recordIntentProcessed('sui_lz', 'failure');

    const out = await service.getMetrics();

    expect(out).toContain('bosphor_relayer_intents_processed_total{result="success",path="evm"} 2');
    expect(out).toContain(
      'bosphor_relayer_intents_processed_total{result="failure",path="sui_lz"} 1',
    );
  });

  it('counts LZ send outcomes by result', async () => {
    service.recordLzSend('success');
    service.recordLzSend('failure');
    service.recordLzSend('failure');

    const out = await service.getMetrics();

    expect(out).toContain('bosphor_relayer_lz_send_total{result="success"} 1');
    expect(out).toContain('bosphor_relayer_lz_send_total{result="failure"} 2');
  });

  it('counts return legs by settlement mode', async () => {
    service.recordReturnMode('proof');
    service.recordReturnMode('fallback');
    service.recordReturnMode('fallback');

    const out = await service.getMetrics();

    expect(out).toContain('bosphor_relayer_return_mode_total{mode="proof"} 1');
    expect(out).toContain('bosphor_relayer_return_mode_total{mode="fallback"} 2');
  });

  it('initializes both return-mode series to 0 so panels render from boot', async () => {
    const out = await service.getMetrics();

    expect(out).toContain('bosphor_relayer_return_mode_total{mode="proof"} 0');
    expect(out).toContain('bosphor_relayer_return_mode_total{mode="fallback"} 0');
  });

  it('reports the latest checkpoint cursor lag as a gauge', async () => {
    service.setCheckpointCursorLag(7);
    service.setCheckpointCursorLag(3);

    const out = await service.getMetrics();

    expect(out).toContain('bosphor_relayer_checkpoint_cursor_lag 3');
  });

  it('records Walrus upload durations as a histogram', async () => {
    service.observeWalrusUpload(0.5);
    service.observeWalrusUpload(2.5);

    const out = await service.getMetrics();

    expect(out).toContain('bosphor_relayer_walrus_upload_seconds_count 2');
    expect(out).toContain('bosphor_relayer_walrus_upload_seconds_sum 3');
  });
});
