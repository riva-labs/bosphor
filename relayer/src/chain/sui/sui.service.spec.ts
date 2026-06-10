import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SuiService } from './sui.service';

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

describe('SuiService.getCheckpoint', () => {
  let service: SuiService;
  let mockGetServiceInfo: jest.Mock;

  beforeEach(async () => {
    mockGetServiceInfo = jest.fn().mockResolvedValue({
      response: {
        checkpointHeight: 12345n,
      },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    service = module.get<SuiService>(SuiService);
    service.onModuleInit();

    const client = service.getClient();
    client.ledgerService.getServiceInfo = mockGetServiceInfo;
  });

  it('should return the latest checkpoint via gRPC ledgerService', async () => {
    const checkpoint = await service.getCheckpoint();
    expect(checkpoint).toBe('12345');
    expect(mockGetServiceInfo).toHaveBeenCalledTimes(1);
  });
});

describe('SuiService walrus plugin', () => {
  let service: SuiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    service = module.get<SuiService>(SuiService);
    service.onModuleInit();
  });

  it('should extend the client with walrus plugin', () => {
    const client = service.getWalrusClient();
    expect(client).toBeDefined();
    expect(client.walrus).toBeDefined();
  });

  it('should expose the keypair as signer', () => {
    const signer = service.getSigner();
    expect(signer).toBeDefined();
    expect(signer.toSuiAddress()).toBe(service.getAddress());
  });

  it('should return the same extended client from getWalrusClient', () => {
    const client1 = service.getWalrusClient();
    const client2 = service.getWalrusClient();
    expect(client1).toBe(client2);
  });
});
