import { ConfigService } from '@nestjs/config';
import { WalTopUpService } from './wal-topup.service';
import { SuiService } from '../chain/sui/sui.service';
import { MetricsService } from '../metrics/metrics.service';
import { WAL_COIN_TYPE, SUI_COIN_TYPE } from '../common/constants';

const GWEI = 1_000_000_000n; // 1 whole unit (SUI/WAL have 9 decimals)

function makeConfig() {
  const defaults: Record<string, number> = {
    WAL_MIN_BALANCE_MIST: 500_000_000, // 0.5 WAL
    WAL_TOPUP_SUI_MIST: 1_000_000_000, // 1 SUI
    WAL_TOPUP_SUI_RESERVE_MIST: 1_000_000_000, // 1 SUI
  };
  return { get: (key: string, d?: number) => defaults[key] ?? d } as unknown as ConfigService;
}

function makeSui(state: { wal: bigint; sui: bigint }) {
  const getBalance = jest.fn(({ coinType }: { coinType: string }) =>
    Promise.resolve({
      balance: { balance: String(coinType === WAL_COIN_TYPE ? state.wal : state.sui) },
    }),
  );
  // A successful swap adds 1 WAL to the balance (testnet exchange is ~1:1).
  const signAndExecute = jest.fn().mockImplementation(() => {
    state.wal += GWEI;
    return Promise.resolve({ digest: '0xswap', status: { success: true } });
  });
  const waitForTransaction = jest.fn().mockResolvedValue(undefined);
  const sui = {
    getAddress: () => '0xa11070a3877b77355a0afbc402559cae7501c666819f05491f0337016c219366',
    signAndExecute,
    getClient: () => ({ core: { getBalance, waitForTransaction } }),
  } as unknown as SuiService;
  return { sui, getBalance, signAndExecute, waitForTransaction };
}

function makeMetrics() {
  return {
    setWalBalance: jest.fn(),
    setSuiBalance: jest.fn(),
    recordWalTopUp: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<MetricsService, 'setWalBalance' | 'setSuiBalance' | 'recordWalTopUp'>
  >;
}

function build(state: { wal: bigint; sui: bigint }) {
  const { sui, signAndExecute } = makeSui(state);
  const metrics = makeMetrics();
  const svc = new WalTopUpService(sui, makeConfig(), metrics as unknown as MetricsService);
  svc.onModuleInit();
  return { svc, metrics, signAndExecute };
}

describe('WalTopUpService', () => {
  it('does not swap when WAL is above the floor', async () => {
    const { svc, metrics, signAndExecute } = build({ wal: 2n * GWEI, sui: 10n * GWEI });

    await svc.ensureWal();

    expect(signAndExecute).not.toHaveBeenCalled();
    expect(metrics.recordWalTopUp).not.toHaveBeenCalled();
    expect(metrics.setWalBalance).toHaveBeenCalledWith(2);
  });

  it('swaps SUI for WAL when below the floor and SUI is sufficient', async () => {
    const { svc, metrics, signAndExecute } = build({ wal: GWEI / 10n, sui: 10n * GWEI });

    await svc.ensureWal();

    expect(signAndExecute).toHaveBeenCalledTimes(1);
    expect(metrics.recordWalTopUp).toHaveBeenCalledWith('success');
    // Final gauge reflects the post-swap balance (0.1 + 1 WAL).
    expect(metrics.setWalBalance).toHaveBeenLastCalledWith(1.1);
  });

  it('does not swap when SUI is too low to cover swap + reserve', async () => {
    // 1.5 SUI < 1 (swap) + 1 (reserve)
    const { svc, metrics, signAndExecute } = build({ wal: GWEI / 10n, sui: (3n * GWEI) / 2n });

    await svc.ensureWal();

    expect(signAndExecute).not.toHaveBeenCalled();
    expect(metrics.recordWalTopUp).toHaveBeenCalledWith('insufficient_sui');
  });

  it('serializes concurrent calls into a single swap', async () => {
    const { svc, signAndExecute } = build({ wal: GWEI / 10n, sui: 10n * GWEI });

    await Promise.all([svc.ensureWal(), svc.ensureWal(), svc.ensureWal()]);

    expect(signAndExecute).toHaveBeenCalledTimes(1);
  });
});
