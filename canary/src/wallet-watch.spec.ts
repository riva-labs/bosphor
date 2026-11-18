import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WalletWatcher } from './wallet-watch.ts';
import type { ChainAdapter } from './wallet-chains.ts';
import { parseWalletWatch } from './wallet-config.ts';

function fakeMetrics() {
  const balances: Record<string, number> = {};
  const errors: string[] = [];
  const topups: string[] = [];
  return {
    balances,
    errors,
    topups,
    setWalletBalance: (l: { role: string; coin: string }, v: number) => {
      balances[`${l.role}:${l.coin}`] = v;
    },
    recordWalletReadError: (c: string, r: string) => void errors.push(`${c}:${r}`),
    recordTopUp: (c: string, r: string, res: string) => void topups.push(`${c}:${r}:${res}`),
  };
}

function fakeSui(
  balances: Record<string, number>,
  opts: { network?: string; fail?: string[]; sendFails?: boolean } = {},
) {
  const sent: { to: string; amount: number }[] = [];
  const adapter: ChainAdapter = {
    chain: 'sui',
    detectNetwork: async () => opts.network ?? 'testnet',
    readBalance: async (w) => {
      if (opts.fail?.includes(w.address)) throw new Error('rpc down');
      return balances[w.address];
    },
    treasury: {
      address: '0xtreasury',
      floor: 10,
      send: async (to, amount) => {
        if (opts.sendFails) throw new Error('tx failed');
        sent.push({ to, amount });
        return 'digest';
      },
    },
  };
  return { adapter, sent };
}

const wallets = parseWalletWatch(
  JSON.stringify([
    { chain: 'sui', network: 'testnet', address: '0xrelayer', role: 'relayer', floor: 1, target: 5, dailyCap: 6 },
    { chain: 'sui', network: 'testnet', address: '0xdvn', role: 'dvn' },
    { chain: 'sui', network: 'testnet', address: '0xtreasury', role: 'treasury', floor: 10, target: 20 },
  ]),
);

test('publishes every balance and tops up a wallet below its floor', async () => {
  const m = fakeMetrics();
  const { adapter, sent } = fakeSui({ '0xrelayer': 0.5, '0xdvn': 3, '0xtreasury': 100 });
  await new WalletWatcher({ wallets, adapters: { sui: adapter }, metrics: m, topUpEnabled: true, log: () => {} }).tick();

  assert.deepEqual(m.balances, { 'relayer:SUI': 0.5, 'dvn:SUI': 3, 'treasury:SUI': 100 });
  assert.deepEqual(sent, [{ to: '0xrelayer', amount: 4.5 }]);
  assert.deepEqual(m.topups, ['sui:relayer:success']);
});

test('a failed read counts an error, sets no value and never tops up that wallet', async () => {
  const m = fakeMetrics();
  const { adapter, sent } = fakeSui({ '0xrelayer': 0.5, '0xdvn': 3, '0xtreasury': 100 }, { fail: ['0xrelayer'] });
  await new WalletWatcher({ wallets, adapters: { sui: adapter }, metrics: m, topUpEnabled: true, log: () => {} }).tick();

  assert.equal('relayer:SUI' in m.balances, false);
  assert.deepEqual(m.errors, ['sui:relayer']);
  assert.deepEqual(sent, []);
});

test('the daily cap holds across ticks', async () => {
  const m = fakeMetrics();
  const { adapter, sent } = fakeSui({ '0xrelayer': 0.5, '0xdvn': 3, '0xtreasury': 100 });
  const w = new WalletWatcher({ wallets, adapters: { sui: adapter }, metrics: m, topUpEnabled: true, log: () => {} });
  await w.tick(); // sends 4.5 (cap 6)
  await w.tick(); // balance still reads 0.5: only 1.5 left of the cap
  await w.tick(); // cap exhausted
  assert.deepEqual(
    sent.map((s) => s.amount),
    [4.5, 1.5],
  );
  assert.equal(m.topups.at(-1), 'sui:relayer:daily_cap');
});

test('mainnet RPC: no funds move even with TOPUP_ENABLED', async () => {
  const m = fakeMetrics();
  const logs: string[] = [];
  const { adapter, sent } = fakeSui({ '0xrelayer': 0.5, '0xdvn': 3, '0xtreasury': 100 }, { network: 'mainnet' });
  await new WalletWatcher({
    wallets,
    adapters: { sui: adapter },
    metrics: m,
    topUpEnabled: true,
    log: (l) => void logs.push(l),
  }).tick();
  assert.deepEqual(sent, []);
  assert.ok(logs.some((l) => l.includes('not a test network')));
});

test('TOPUP_ENABLED unset: no funds move', async () => {
  const m = fakeMetrics();
  const { adapter, sent } = fakeSui({ '0xrelayer': 0.5, '0xdvn': 3, '0xtreasury': 100 });
  await new WalletWatcher({ wallets, adapters: { sui: adapter }, metrics: m, topUpEnabled: false, log: () => {} }).tick();
  assert.deepEqual(sent, []);
  assert.deepEqual(m.topups, []);
});

test('a failed send is counted as an error', async () => {
  const m = fakeMetrics();
  const { adapter } = fakeSui({ '0xrelayer': 0.5, '0xdvn': 3, '0xtreasury': 100 }, { sendFails: true });
  await new WalletWatcher({ wallets, adapters: { sui: adapter }, metrics: m, topUpEnabled: true, log: () => {} }).tick();
  assert.deepEqual(m.topups, ['sui:relayer:error']);
});
