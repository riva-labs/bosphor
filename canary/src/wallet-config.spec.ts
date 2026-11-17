import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isNativeCoin, loadWalletWatch, parseWalletWatch } from './wallet-config.ts';

const WAL = '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL';

test('parses entries with native defaults per chain', () => {
  const [sui, evm, sol] = parseWalletWatch(
    JSON.stringify([
      { chain: 'sui', network: 'testnet', address: '0xabc', role: 'relayer', floor: 1, target: 5 },
      { chain: 'evm', network: 'Sepolia', address: '0xdef', role: 'operator' },
      { chain: 'solana', network: 'devnet', address: 'BQv', role: 'relayer', dailyCap: 3, floor: 1, target: 2 },
    ]),
  );
  assert.equal(sui.coin, 'SUI');
  assert.equal(sui.decimals, 9);
  assert.equal(sui.dailyCap, 5, 'dailyCap defaults to one full refill (target)');
  assert.equal(isNativeCoin(sui), true);
  assert.equal(evm.coin, 'ETH');
  assert.equal(evm.decimals, 18);
  assert.equal(evm.network, 'sepolia');
  assert.equal(evm.floor, undefined);
  assert.equal(sol.coin, 'SOL');
  assert.equal(sol.dailyCap, 3);
});

test('a Sui coin type becomes the coin label and is not native', () => {
  const [w] = parseWalletWatch(
    JSON.stringify([{ chain: 'sui', network: 'testnet', address: '0xabc', role: 'relayer', coin: WAL }]),
  );
  assert.equal(w.coin, 'WAL');
  assert.equal(w.coinType, WAL);
  assert.equal(isNativeCoin(w), false);
});

test('rejects malformed entries loudly', () => {
  const bad = [
    [{ chain: 'btc', network: 'testnet', address: 'x', role: 'r' }],
    [{ chain: 'sui', network: 'testnet', role: 'r' }],
    [{ chain: 'sui', network: 'testnet', address: 'x', role: 'r', floor: 1 }],
    [{ chain: 'sui', network: 'testnet', address: 'x', role: 'r', floor: 5, target: 5 }],
    [{ chain: 'sui', network: 'testnet', address: 'x', role: 'r', floor: -1, target: 5 }],
    [
      { chain: 'sui', network: 'testnet', address: '0xA', role: 'r' },
      { chain: 'sui', network: 'testnet', address: '0xa', role: 'r2' },
    ],
    { not: 'an array' },
  ];
  for (const b of bad) assert.throws(() => parseWalletWatch(JSON.stringify(b)));
});

test('unset WALLET_WATCH means no watcher', () => {
  assert.deepEqual(loadWalletWatch(undefined), []);
  assert.deepEqual(loadWalletWatch('  '), []);
});
