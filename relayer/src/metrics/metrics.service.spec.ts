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
});
