import { ChainEscrowReader, EvmEscrowSource, SolanaEscrowSource } from './chain-escrow-reader';
import { ConfigService } from '@nestjs/config';

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';

function make(
  evm: Partial<EvmEscrowSource> = {},
  solana: Partial<SolanaEscrowSource> = {},
  solanaSrcEid = 40168,
): ChainEscrowReader {
  return new ChainEscrowReader(
    { getEscrow: jest.fn().mockResolvedValue(null), ...evm } as EvmEscrowSource,
    { getEscrow: jest.fn().mockResolvedValue(null), ...solana } as SolanaEscrowSource,
    { get: (_k: string, d?: unknown) => (solanaSrcEid ?? d) } as unknown as ConfigService,
  );
}

describe('ChainEscrowReader', () => {
  it('maps a native EVM escrow to ETH', async () => {
    const reader = make({
      getEscrow: jest.fn().mockResolvedValue({ token: ZERO, amount: 800_000_000_000_000n, status: 1 }),
    });
    const info = await reader.getEscrow('0xabc', 40161);
    expect(info).toEqual({ escrowNative: 800_000_000_000_000n, originToken: 'ETH' });
  });

  it('routes a Solana-origin intent to the Solana vault and maps to SOL', async () => {
    const solGet = jest.fn().mockResolvedValue({ amount: 20_000_000n, status: 1 });
    const evmGet = jest.fn();
    const reader = make({ getEscrow: evmGet }, { getEscrow: solGet });
    const info = await reader.getEscrow('0xabc', 40168);
    expect(info).toEqual({ escrowNative: 20_000_000n, originToken: 'SOL' });
    expect(evmGet).not.toHaveBeenCalled();
    expect(solGet).toHaveBeenCalledWith('0xabc');
  });

  it('returns null when there is no escrow (guard not applied)', async () => {
    const reader = make({ getEscrow: jest.fn().mockResolvedValue(null) });
    expect(await reader.getEscrow('0xabc', 40161)).toBeNull();
  });

  it('returns null for a zero-amount escrow', async () => {
    const reader = make({
      getEscrow: jest.fn().mockResolvedValue({ token: ZERO, amount: 0n, status: 1 }),
    });
    expect(await reader.getEscrow('0xabc', 40161)).toBeNull();
  });

  it('does not price a non-native (USDC) EVM escrow as native', async () => {
    const reader = make({
      getEscrow: jest.fn().mockResolvedValue({ token: USDC, amount: 5_000_000n, status: 1 }),
    });
    expect(await reader.getEscrow('0xabc', 40161)).toBeNull();
  });
});
