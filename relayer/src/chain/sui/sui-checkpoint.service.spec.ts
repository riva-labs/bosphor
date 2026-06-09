import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SuiService } from './sui.service';
import { SuiCheckpointService } from './sui-checkpoint.service';

// Raw 32-byte Ed25519 secret key in base64 (test only)
const FAKE_RELAYER_KEY = 'Jts4zLNTiUvi61WLpwYCEC/EArGJQuaYAIalHTkr+U4=';

const BOSPHOR = {
  lzPackageId: '0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656',
  configId: '0xea751eeb901093cf8f45532876c12408f0cc627aad570f6112b2dc2ee8d9e432',
  oappId: '0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0',
  messagingChannel: '0x1d1058fd590c44154a92282ebaab621aae10df0982466a433e9c9a18fe9c8301',
};

function makeConfigService(overrides: Record<string, string> = {}) {
  const defaultMap: Record<string, string> = {
    SUI_GRPC_URL: 'https://sui-testnet.mystenlabs.com',
    SUI_RELAYER_KEY: FAKE_RELAYER_KEY,
    SUI_PACKAGE_ID: '0xdeadbeef',
    SUI_CONFIG_ID: '0xconfigid',
    WALRUS_RELAY_URL: 'https://relay.walrus-testnet.walrus.space',
    SUI_LZ_OAPP_ID: BOSPHOR.oappId,
    SUI_LZ_MESSAGING_CHANNEL: BOSPHOR.messagingChannel,
    SUI_LZ_PACKAGE_ID: BOSPHOR.lzPackageId,
    SUI_LZ_CONFIG_ID: BOSPHOR.configId,
  };
  const map = { ...defaultMap, ...overrides };
  return {
    getOrThrow: jest.fn((key: string) => {
      if (map[key] !== undefined) return map[key];
      throw new Error(`Missing config: ${key}`);
    }),
    get: jest.fn((key: string, defaultValue?: string) => {
      return map[key] ?? defaultValue ?? '';
    }),
  };
}

describe('SuiCheckpointService.processCheckpoint', () => {
  let suiService: SuiService;
  let checkpointService: SuiCheckpointService;
  let mockCallback: jest.Mock;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiService,
        SuiCheckpointService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    suiService = module.get<SuiService>(SuiService);
    checkpointService = module.get<SuiCheckpointService>(SuiCheckpointService);
    suiService.onModuleInit();

    mockCallback = jest.fn().mockResolvedValue(undefined);
    checkpointService.setOnEventCallback(mockCallback);
  });

  const LZ_PKG = '0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656';
  const EVENT_TYPE = `${LZ_PKG}::lz_receiver::IntentReceived`;

  function makeCheckpoint(events: any[]) {
    return {
      transactions: [{
        digest: 'txdigest123',
        events: { events },
      }],
    };
  }

  it('should invoke callback for matching IntentReceived events', async () => {
    const intentBytes = Array.from({ length: 32 }, (_, i) => i);
    const checkpoint = makeCheckpoint([{
      eventType: EVENT_TYPE,
      json: {
        value: {
          intent_id: intentBytes,
          payload: [1, 2, 3],
          src_eid: 40161,
          nonce: '1',
        },
      },
    }]);

    await checkpointService.processCheckpoint(checkpoint, 100n);

    expect(mockCallback).toHaveBeenCalledTimes(1);
    const event = mockCallback.mock.calls[0][0];
    expect(event.intentId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(event.payload).toEqual([1, 2, 3]);
    expect(event.srcEid).toBe(40161);
  });

  it('should skip events with non-matching event type', async () => {
    const checkpoint = makeCheckpoint([{
      eventType: `${LZ_PKG}::lz_receiver::ProofSent`,
      json: { value: { intent_id: [1], payload: [], src_eid: 1, nonce: '0' } },
    }]);

    await checkpointService.processCheckpoint(checkpoint, 100n);

    expect(mockCallback).not.toHaveBeenCalled();
  });

  it('should skip events with no json value', async () => {
    const checkpoint = makeCheckpoint([{
      eventType: EVENT_TYPE,
      json: null,
    }]);

    await checkpointService.processCheckpoint(checkpoint, 100n);

    expect(mockCallback).not.toHaveBeenCalled();
  });

  it('should skip events with malformed JSON string', async () => {
    const checkpoint = makeCheckpoint([{
      eventType: EVENT_TYPE,
      json: { value: '{ broken json' },
    }]);

    await checkpointService.processCheckpoint(checkpoint, 100n);

    expect(mockCallback).not.toHaveBeenCalled();
  });

  it('should handle JSON as string (parses it)', async () => {
    const intentBytes = Array.from({ length: 32 }, () => 0xab);
    const checkpoint = makeCheckpoint([{
      eventType: EVENT_TYPE,
      json: {
        value: JSON.stringify({
          intent_id: intentBytes,
          payload: [10, 20],
          src_eid: 40378,
          nonce: '5',
        }),
      },
    }]);

    await checkpointService.processCheckpoint(checkpoint, 200n);

    expect(mockCallback).toHaveBeenCalledTimes(1);
    expect(mockCallback.mock.calls[0][0].srcEid).toBe(40378);
  });

  it('should not invoke callback when none is registered', async () => {
    checkpointService.setOnEventCallback(undefined as any);
    (checkpointService as any).onEventCallback = undefined;

    const intentBytes = Array.from({ length: 32 }, () => 0);
    const checkpoint = makeCheckpoint([{
      eventType: EVENT_TYPE,
      json: {
        value: { intent_id: intentBytes, payload: [], src_eid: 1, nonce: '0' },
      },
    }]);

    // Should not throw
    await checkpointService.processCheckpoint(checkpoint, 100n);
  });

  it('should handle checkpoint with no transactions', async () => {
    await checkpointService.processCheckpoint({}, 100n);
    expect(mockCallback).not.toHaveBeenCalled();
  });
});
