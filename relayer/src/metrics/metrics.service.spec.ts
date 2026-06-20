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

    expect(out).toContain(
      'bosphor_relayer_intents_processed_total{result="success",path="evm"} 2',
    );
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
