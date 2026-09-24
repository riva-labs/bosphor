import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Transaction } from '@mysten/sui/transactions';
import { SuiService, WALRUS_SEND_TIP_MAX_MIST, executeStoreAbiFromParams } from './sui.service';

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
      providers: [SuiService, { provide: ConfigService, useValue: makeConfigService() }],
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
      providers: [SuiService, { provide: ConfigService, useValue: makeConfigService() }],
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

  it('should permit mainnet-scale upload-relay tips above the old 1M cap', () => {
    // Mainnet upload-relay tips have been observed at ~2.58M MIST, which the
    // old hardcoded 1M cap rejected with "Tip amount exceeds maximum". The
    // send-tip ceiling must stay well clear of real mainnet tips.
    const OBSERVED_MAINNET_TIP_MIST = 2_580_000;
    expect(WALRUS_SEND_TIP_MAX_MIST).toBeGreaterThan(OBSERVED_MAINNET_TIP_MIST);
  });
});

// Normalized execute_store parameter lists as returned by getMoveFunction
// (the trailing &mut TxContext is included).
const obj = { body: { $kind: 'datatype' } };
const bytes = { body: { $kind: 'vector' } };
const addr = { body: { $kind: 'address' } };
const u64 = { body: { $kind: 'u64' } };
const LEGACY_PARAMS = [obj, obj, obj, bytes, obj, u64, obj, addr, obj];
const COMMITTED_PARAMS = [obj, obj, obj, bytes, obj, obj, addr, obj];

describe('executeStoreAbiFromParams', () => {
  it('detects the legacy relayer-deadline signature', () => {
    expect(executeStoreAbiFromParams(LEGACY_PARAMS)).toBe('legacy-deadline-arg');
  });

  it('detects the committed-deadline signature (#374)', () => {
    expect(executeStoreAbiFromParams(COMMITTED_PARAMS)).toBe('committed-deadline');
  });

  it('throws on an unrecognized signature instead of guessing', () => {
    expect(() => executeStoreAbiFromParams([obj, u64])).toThrow(/Unrecognized/);
  });
});

describe('SuiService.executeStore', () => {
  const INTENT_ID = '0x' + '11'.repeat(32);
  const SENDER = '0x' + 'ab'.repeat(32);
  const BLOB_OBJ = '0x' + 'cd'.repeat(32);
  let service: SuiService;
  let getMoveFunction: jest.SpyInstance;
  let moveCall: jest.SpyInstance;

  afterEach(() => moveCall.mockRestore());

  async function setup(params: typeof LEGACY_PARAMS) {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiService,
        {
          provide: ConfigService,
          useValue: makeConfigService({ SUI_WALRUS_SYSTEM_ID: '0x' + '22'.repeat(32) }),
        },
      ],
    }).compile();
    service = module.get<SuiService>(SuiService);
    service.onModuleInit();
    getMoveFunction = jest
      .spyOn(service.getClient().core, 'getMoveFunction')
      .mockResolvedValue({ function: { parameters: params } } as never);
    jest
      .spyOn(service, 'signAndExecute')
      .mockResolvedValue({ digest: '0xdigest', status: { success: true } } as never);
    moveCall = jest.spyOn(Transaction.prototype, 'moveCall');
  }

  /** Arguments of the execute_store MoveCall the service built. */
  function sentArgs(): unknown[] {
    const call = moveCall.mock.calls.find(([c]) => String(c.target).endsWith('::execute_store'));
    return call![0].arguments as unknown[];
  }

  it('omits the deadline argument on a committed-deadline package', async () => {
    await setup(COMMITTED_PARAMS);
    await expect(service.executeStore(INTENT_ID, SENDER, BLOB_OBJ, 123_000n)).resolves.toBe(
      '0xdigest',
    );
    // config, lz_config, system, intent_id, blob, clock, original_sender
    expect(sentArgs()).toHaveLength(7);
    // Slot 5 is the Clock, not a relayer-supplied u64.
    expect((sentArgs()[5] as { type?: string }).type).not.toBe('pure');
  });

  it('still passes deadline_ms to a legacy package', async () => {
    await setup(LEGACY_PARAMS);
    await service.executeStore(INTENT_ID, SENDER, BLOB_OBJ, 123_000n);
    // ... blob, deadline_ms, clock, original_sender
    expect(sentArgs()).toHaveLength(8);
    // deadline_ms sits right after the blob, before the Clock.
    expect((sentArgs()[5] as { type?: string }).type).toBe('pure');
    expect((sentArgs()[6] as { type?: string }).type).not.toBe('pure');
  });

  it('resolves the ABI once and reuses it', async () => {
    await setup(COMMITTED_PARAMS);
    await service.executeStore(INTENT_ID, SENDER, BLOB_OBJ, 1n);
    await service.executeStore(INTENT_ID, SENDER, BLOB_OBJ, 1n);
    expect(getMoveFunction).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed ABI lookup', async () => {
    await setup(COMMITTED_PARAMS);
    getMoveFunction.mockRejectedValueOnce(new Error('rpc down'));
    await expect(service.executeStore(INTENT_ID, SENDER, BLOB_OBJ, 1n)).rejects.toThrow('rpc down');
    await expect(service.executeStore(INTENT_ID, SENDER, BLOB_OBJ, 1n)).resolves.toBe('0xdigest');
    expect(getMoveFunction).toHaveBeenCalledTimes(2);
  });
});
