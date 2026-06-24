import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { Transaction } from '@mysten/sui/transactions';
import { SuiService } from './sui.service';
import { SuiLzService } from './sui-lz.service';

// LZ infrastructure IDs (testnet, from verified TX)
const LZ_INFRA = {
  endpointV2: '0xabf9629418d997fcc742a5ca22820241b72fb53691f010bc964eb49b4bd2263a',
  endpointV2Obj: '0x2b96537c30c5fa962a1bfb58a168fc17c17f2546c88e2e9252f21ee7d5eff57a',
  uln302: '0xf5d69c7b0922ce0ab4540525fbc66ca25ce9f092c64b032b91e4c5625ea0fb24',
  uln302Obj: '0x69541d4feeb08cdd3b20b3502021a676eea0fca4f47d46e423cdc9686df406ff',
  executorPkg: '0xb9fdc6748fb939095e249b22717d564edf890681e387131d6c525d867d30f834',
  executorObj: '0x51816836a18df1cc8bbc0ae840e01da8fef15968ddbb390f4d6b9243b7911f23',
  execFeeLib: '0xa99c7ca780a6cedfc27d9274c031741b68014886cba04dafe8335c72eeeed0b5',
  execFeeLibObj: '0x4e0c4cc4aa88b428005a8bb131014fdf9637a3ae042f192b9071119a64a32138',
  dvnPkg: '0xfa5a7bd745a56f3f18f4830563c8b65a737dcfca5b9e5aa281f2f2cd3f6eaf6d',
  dvnObj: '0x4160cd9281e79a93f87f7f45853cd682750102be01f36d1c33ef99ee8cd86e0d',
  dvnFeeLib: '0xfb596f2afcc4f15ec8660fb241c3a7b9aa2f9b3b820914b6990202b5f236f2f',
  dvnFeeLibObj: '0xd433507170ea8cf08c5697128e80fca03f5c03c4a2f639bc632e6647baff63e1',
  priceFeed: '0xa4f8f126dc7e2a763676eab3a6f0a12afaf334baa0f37b41a1e93890cf95ea4c',
  priceFeedObj: '0xc8ae95cdc862a032e4d35f5f4c5dd6d3d07bdde2c7f39460e78e1539cc07dc2d',
  treasury: '0xb9ae7adf8193fb0bf2cc99d89dac19ae309c0f1b768d0976166f507c1daa9936',
  treasuryObj: '0x40a2b309bda42658dd12e967574f6e77170082599a77b158051c31064df82be1',
};

const BOSPHOR = {
  lzPackageId: '0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656',
  configId: '0xea751eeb901093cf8f45532876c12408f0cc627aad570f6112b2dc2ee8d9e432',
  oappId: '0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0',
  messagingChannel: '0x1d1058fd590c44154a92282ebaab621aae10df0982466a433e9c9a18fe9c8301',
};

// Raw 32-byte Ed25519 secret key in base64 (test only)
const FAKE_RELAYER_KEY = 'Jts4zLNTiUvi61WLpwYCEC/EArGJQuaYAIalHTkr+U4=';

// Dummy BCS bytes returned by Transaction.build() in tests.
const DUMMY_TX_BYTES = new Uint8Array(64);

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
    SUI_LZ_ENDPOINT_V2: LZ_INFRA.endpointV2,
    SUI_LZ_ENDPOINT_V2_OBJ: LZ_INFRA.endpointV2Obj,
    SUI_LZ_ULN302: LZ_INFRA.uln302,
    SUI_LZ_ULN302_OBJ: LZ_INFRA.uln302Obj,
    SUI_LZ_EXECUTOR_PKG: LZ_INFRA.executorPkg,
    SUI_LZ_EXECUTOR_OBJ: LZ_INFRA.executorObj,
    SUI_LZ_EXEC_FEE_LIB: LZ_INFRA.execFeeLib,
    SUI_LZ_EXEC_FEE_LIB_OBJ: LZ_INFRA.execFeeLibObj,
    SUI_LZ_DVN_PKG: LZ_INFRA.dvnPkg,
    SUI_LZ_DVN_OBJ: LZ_INFRA.dvnObj,
    SUI_LZ_DVN_FEE_LIB: LZ_INFRA.dvnFeeLib,
    SUI_LZ_DVN_FEE_LIB_OBJ: LZ_INFRA.dvnFeeLibObj,
    SUI_LZ_PRICE_FEED: LZ_INFRA.priceFeed,
    SUI_LZ_PRICE_FEED_OBJ: LZ_INFRA.priceFeedObj,
    SUI_LZ_TREASURY: LZ_INFRA.treasury,
    SUI_LZ_TREASURY_OBJ: LZ_INFRA.treasuryObj,
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

describe('SuiLzService.lzSendProof', () => {
  let suiService: SuiService;
  let lzService: SuiLzService;
  let mockExecuteTransaction: jest.Mock;

  beforeEach(async () => {
    mockExecuteTransaction = jest.fn().mockResolvedValue({
      $kind: 'Transaction',
      Transaction: {
        digest: 'fakedigest123',
        status: { success: true, error: null },
      },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiService,
        SuiLzService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    suiService = module.get<SuiService>(SuiService);
    lzService = module.get<SuiLzService>(SuiLzService);
    suiService.onModuleInit();

    const client = suiService.getClient();
    client.core.executeTransaction = mockExecuteTransaction;
    jest.spyOn(Transaction.prototype, 'build').mockResolvedValue(DUMMY_TX_BYTES);
  });

  it('should build a PTB and execute it successfully', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const blobId = 'zc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc0';
    const endEpoch = 100;
    const dstEid = 40161;

    const digest = await lzService.lzSendProof(intentId, blobId, endEpoch, dstEid, 110_000_000n);

    expect(digest).toBe('fakedigest123');
    expect(mockExecuteTransaction).toHaveBeenCalledTimes(1);

    const callArgs = mockExecuteTransaction.mock.calls[0][0];
    expect(callArgs).toHaveProperty('transaction');
    expect(callArgs).toHaveProperty('signatures');
  });

  it('should throw when Sui transaction fails', async () => {
    mockExecuteTransaction.mockResolvedValue({
      $kind: 'Transaction',
      Transaction: {
        digest: 'faileddigest',
        status: { success: false, error: 'out of gas' },
      },
    });

    const intentId = '0x' + 'ab'.repeat(32);
    const blobId = 'zc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc0';

    await expect(lzService.lzSendProof(intentId, blobId, 100, 40161, 110_000_000n)).rejects.toThrow(
      /Sui tx failed/,
    );
  });

  it('should throw when LZ config is missing', async () => {
    const module2: TestingModule = await Test.createTestingModule({
      providers: [
        SuiService,
        SuiLzService,
        {
          provide: ConfigService,
          useValue: makeConfigService({
            SUI_LZ_OAPP_ID: '',
            SUI_LZ_MESSAGING_CHANNEL: '',
            SUI_LZ_CONFIG_ID: '',
            SUI_LZ_PACKAGE_ID: '',
            SUI_LZ_ENDPOINT_V2: '',
            SUI_LZ_ULN302_OBJ: '',
          }),
        },
      ],
    }).compile();

    const sui = module2.get<SuiService>(SuiService);
    sui.onModuleInit();
    const lz = module2.get<SuiLzService>(SuiLzService);

    await expect(
      lz.lzSendProof('0x' + 'ab'.repeat(32), 'dGVzdA', 100, 40161, 110_000_000n),
    ).rejects.toThrow(/LZ send proof requires/);
  });
});

describe('SuiLzService.quoteLzFee', () => {
  let suiService: SuiService;
  let lzService: SuiLzService;
  let mockSimulate: jest.Mock;

  beforeEach(async () => {
    // BCS-encode MessagingFee { native_fee: u64, zro_fee: u64 }
    // native_fee = 100_000_000 (0.1 SUI), zro_fee = 0
    const nativeFeeBytes = [0x00, 0xe1, 0xf5, 0x05, 0x00, 0x00, 0x00, 0x00];
    const zroFeeBytes = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];

    // Mirror server behavior: the gRPC FieldMask uses snake_case proto paths.
    // Command return values only populate when 'command_outputs.return_values'
    // is requested; the camelCase parent 'commandOutputs' yields an empty array.
    mockSimulate = jest.fn().mockImplementation((req: { readMask?: { paths?: string[] } }) => {
      const paths = req.readMask?.paths ?? [];
      const populated = paths.includes('command_outputs.return_values');
      return Promise.resolve({
        response: {
          commandOutputs: populated
            ? [
                // 15 intermediate commands
                ...Array(15).fill({ returnValues: [] }),
                // Last command returns MessagingFee
                {
                  returnValues: [
                    {
                      value: { value: new Uint8Array([...nativeFeeBytes, ...zroFeeBytes]) },
                    },
                  ],
                },
              ]
            : [],
        },
      });
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SuiService,
        SuiLzService,
        { provide: ConfigService, useValue: makeConfigService() },
      ],
    }).compile();

    suiService = module.get<SuiService>(SuiService);
    lzService = module.get<SuiLzService>(SuiLzService);
    suiService.onModuleInit();

    const client = suiService.getClient();
    client.transactionExecutionService.simulateTransaction = mockSimulate;
    jest.spyOn(Transaction.prototype, 'build').mockResolvedValue(DUMMY_TX_BYTES);
  });

  it('should call simulateTransaction and return the quoted native fee', async () => {
    const intentId = '0x' + 'ab'.repeat(32);
    const blobId = 'zc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc0';
    const endEpoch = 100;
    const dstEid = 40161;

    const fee = await lzService.quoteLzFee(intentId, blobId, endEpoch, dstEid);

    expect(fee).toBe(100_000_000n);
    expect(mockSimulate).toHaveBeenCalledTimes(1);

    // Verify readMask requests the snake_case leaf path. The camelCase parent
    // 'commandOutputs' is silently returned empty by the server, which would
    // drop the quote to the oversized hardcoded fallback fee.
    const callArgs = mockSimulate.mock.calls[0][0];
    expect(callArgs.readMask?.paths).toContain('command_outputs.return_values');
    expect(callArgs.transaction?.bcs?.value).toBeDefined();
  });

  it('would fail to parse if the readMask used the camelCase parent path', async () => {
    // Regression guard: the original bug requested 'commandOutputs', which the
    // server returns empty. Proves the snake_case leaf path is load-bearing.
    mockSimulate.mockImplementationOnce(() =>
      Promise.resolve({ response: { commandOutputs: [] } }),
    );

    await expect(
      lzService.quoteLzFee('0x' + 'ab'.repeat(32), 'zc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc0', 100, 40161),
    ).rejects.toThrow(/Failed to parse LZ fee quote/);
  });
});
