import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTopUp, isTestNetwork, TopUpLedger, type TopUpInput } from './topup.ts';

const base: TopUpInput = {
  network: 'testnet',
  treasuryNetwork: 'testnet',
  enabled: true,
  balance: 0.5,
  floor: 1,
  target: 5,
  dailyCap: 10,
  sentLast24h: 0,
  treasuryBalance: 100,
  treasuryFloor: 10,
};

test('below floor: sends target minus balance', () => {
  assert.deepEqual(decideTopUp(base), { action: 'send', amount: 4.5 });
});

test('at or above floor: no top-up', () => {
  assert.deepEqual(decideTopUp({ ...base, balance: 1 }), { action: 'none', reason: 'above_floor' });
  assert.deepEqual(decideTopUp({ ...base, balance: 3 }), { action: 'none', reason: 'above_floor' });
});

test('daily cap reached: no top-up', () => {
  assert.deepEqual(decideTopUp({ ...base, sentLast24h: 10 }), {
    action: 'none',
    reason: 'daily_cap',
  });
});

test('daily cap partially used: sends only what is left of the cap', () => {
  assert.deepEqual(decideTopUp({ ...base, sentLast24h: 8 }), { action: 'send', amount: 2 });
});

test('treasury floor protection: never draws the treasury below its floor', () => {
  assert.deepEqual(decideTopUp({ ...base, treasuryBalance: 12 }), { action: 'send', amount: 2 });
  assert.deepEqual(decideTopUp({ ...base, treasuryBalance: 10 }), {
    action: 'none',
    reason: 'treasury_floor',
  });
  assert.deepEqual(decideTopUp({ ...base, treasuryBalance: 3 }), {
    action: 'none',
    reason: 'treasury_floor',
  });
});

test('mainnet: never sends, even when enabled and below floor', () => {
  assert.deepEqual(decideTopUp({ ...base, network: 'mainnet' }), {
    action: 'none',
    reason: 'not_test_network',
  });
});

test('mislabelled wallet: a mainnet RPC blocks the top-up even if the label says testnet', () => {
  assert.deepEqual(decideTopUp({ ...base, treasuryNetwork: 'mainnet' }), {
    action: 'none',
    reason: 'not_test_network',
  });
});

test('TOPUP_ENABLED not set: no top-up on testnet either', () => {
  assert.deepEqual(decideTopUp({ ...base, enabled: false }), { action: 'none', reason: 'disabled' });
});

test('no floor/target: watch only', () => {
  assert.deepEqual(decideTopUp({ ...base, floor: undefined, target: undefined }), {
    action: 'none',
    reason: 'not_configured',
  });
});

test('isTestNetwork accepts testnet, devnet, sepolia only', () => {
  for (const n of ['testnet', 'devnet', 'sepolia', 'Sepolia']) assert.equal(isTestNetwork(n), true);
  for (const n of ['mainnet', 'ethereum', 'mainnet-beta', '']) assert.equal(isTestNetwork(n), false);
});

test('ledger sums sends inside the rolling 24h window only', () => {
  const l = new TopUpLedger(1000);
  l.record('a', 2, 0);
  l.record('a', 3, 500);
  l.record('b', 7, 500);
  assert.equal(l.sentInWindow('a', 900), 5);
  assert.equal(l.sentInWindow('a', 1200), 3);
  assert.equal(l.sentInWindow('a', 1600), 0);
  assert.equal(l.sentInWindow('b', 900), 7);
});
