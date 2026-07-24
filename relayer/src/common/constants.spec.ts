import { walCoinType, WAL_COIN_TYPE_BY_NETWORK } from './constants';

describe('walCoinType', () => {
  it('returns the mainnet WAL coin type for the mainnet network', () => {
    expect(walCoinType('mainnet')).toBe(WAL_COIN_TYPE_BY_NETWORK.mainnet);
    // Real mainnet WAL package, distinct from testnet.
    expect(walCoinType('mainnet')).toContain('0x356a26eb');
  });

  it('returns the testnet WAL coin type for testnet or when the network is unset', () => {
    expect(walCoinType('testnet')).toBe(WAL_COIN_TYPE_BY_NETWORK.testnet);
    expect(walCoinType(undefined)).toBe(WAL_COIN_TYPE_BY_NETWORK.testnet);
    expect(walCoinType('')).toBe(WAL_COIN_TYPE_BY_NETWORK.testnet);
  });

  it('maps the two networks to different coin types', () => {
    expect(WAL_COIN_TYPE_BY_NETWORK.mainnet).not.toBe(WAL_COIN_TYPE_BY_NETWORK.testnet);
  });
});
