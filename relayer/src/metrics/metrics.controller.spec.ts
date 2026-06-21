import { Test, TestingModule } from '@nestjs/testing';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

describe('MetricsController', () => {
  let controller: MetricsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [MetricsService],
    }).compile();

    controller = module.get<MetricsController>(MetricsController);
  });

  it('exposes Prometheus exposition with the prom content-type and default process metrics', async () => {
    const res = { set: jest.fn() };

    const body = await controller.scrape(res as never);

    expect(res.set).toHaveBeenCalledWith(
      'Content-Type',
      expect.stringContaining('text/plain'),
    );
    expect(body).toContain('process_cpu_seconds_total');
  });
});
