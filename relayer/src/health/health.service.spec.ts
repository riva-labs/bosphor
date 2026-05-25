import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { EvmService } from '../chain/evm/evm.service';
import { SuiService } from '../chain/sui/sui.service';

describe('HealthService', () => {
  let service: HealthService;
  let mockEvm: Partial<EvmService>;
  let mockSui: Partial<SuiService>;

  beforeEach(async () => {
    mockEvm = {
      getBlockNumber: jest.fn().mockResolvedValue(12345),
    };

    mockSui = {
      getCheckpoint: jest.fn().mockResolvedValue('67890'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: EvmService, useValue: mockEvm },
        { provide: SuiService, useValue: mockSui },
      ],
    }).compile();

    service = module.get<HealthService>(HealthService);
  });

  it('should return ok when both chains are connected', async () => {
    const health = await service.getHealth();

    expect(health.status).toBe('ok');
    expect(health.evm).toEqual({ connected: true, blockNumber: 12345 });
    expect(health.sui).toEqual({ connected: true, checkpoint: '67890' });
    expect(health.uptime).toBeGreaterThanOrEqual(0);
  });

  it('should return degraded when EVM check fails', async () => {
    (mockEvm.getBlockNumber as jest.Mock).mockRejectedValue(
      new Error('EVM down'),
    );

    const health = await service.getHealth();

    expect(health.status).toBe('degraded');
    expect(health.evm.connected).toBe(false);
    expect(health.sui).toEqual({ connected: true, checkpoint: '67890' });
  });

  it('should return degraded when Sui check fails', async () => {
    (mockSui.getCheckpoint as jest.Mock).mockRejectedValue(
      new Error('Sui down'),
    );

    const health = await service.getHealth();

    expect(health.status).toBe('degraded');
    expect(health.evm).toEqual({ connected: true, blockNumber: 12345 });
    expect(health.sui.connected).toBe(false);
  });

  it('should return degraded when both chains fail', async () => {
    (mockEvm.getBlockNumber as jest.Mock).mockRejectedValue(
      new Error('EVM down'),
    );
    (mockSui.getCheckpoint as jest.Mock).mockRejectedValue(
      new Error('Sui down'),
    );

    const health = await service.getHealth();

    expect(health.status).toBe('degraded');
    expect(health.evm.connected).toBe(false);
    expect(health.sui.connected).toBe(false);
  });
});
