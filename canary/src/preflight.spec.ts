import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { preflight, effectiveGasPriceWei, type PreflightDeps } from './preflight.ts';

const GWEI = 10n ** 9n;

test('effectiveGasPriceWei gates on gasPrice, not the padded maxFeePerGas ceiling', () => {
  // ethers pads maxFeePerGas to baseFee*2 + tip. At a 31 gwei base fee the
  // ceiling is ~62 gwei; gating on it would skip against a 50 gwei guard even
  // though the tx only pays ~31 gwei. The guard must read the 31.
  const fee = { gasPrice: 31n * GWEI, maxFeePerGas: 62n * GWEI };
  assert.equal(effectiveGasPriceWei(fee), 31n * GWEI);
});

test('effectiveGasPriceWei falls back to maxFeePerGas when gasPrice is absent', () => {
  assert.equal(effectiveGasPriceWei({ gasPrice: null, maxFeePerGas: 40n * GWEI }), 40n * GWEI);
});

test('effectiveGasPriceWei returns 0 when the node returns no fee data', () => {
  assert.equal(effectiveGasPriceWei({ gasPrice: null, maxFeePerGas: null }), 0n);
});

function baseDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  return {
    getBalanceWei: async () => ethers.parseEther('0.1'),
    getGasPriceWei: async () => 3n * GWEI,
    minBalanceWei: ethers.parseEther('0.005'),
    maxGasWei: 50n * GWEI,
    ...overrides,
  };
}

test('passes when balance is healthy and gas is normal', async () => {
  const r = await preflight(baseDeps());
  assert.equal(r.ok, true);
  assert.equal(r.reason, undefined);
  assert.equal(r.balanceEth, 0.1);
  assert.equal(r.gasGwei, 3);
});

test('skips with low_balance below the floor', async () => {
  const r = await preflight(baseDeps({ getBalanceWei: async () => ethers.parseEther('0.001') }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'low_balance');
});

test('skips with high_gas above the ceiling (the real 432 gwei spike)', async () => {
  const r = await preflight(baseDeps({ getGasPriceWei: async () => 432n * GWEI }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'high_gas');
  assert.equal(r.gasGwei, 432);
});

test('low_balance takes precedence over high_gas', async () => {
  const r = await preflight(
    baseDeps({
      getBalanceWei: async () => ethers.parseEther('0.001'),
      getGasPriceWei: async () => 432n * GWEI,
    }),
  );
  assert.equal(r.reason, 'low_balance');
});

test('proceeds on a transient balance read error (NaN gauge, not a halt)', async () => {
  const r = await preflight(
    baseDeps({
      getBalanceWei: async () => {
        throw new Error('rpc down');
      },
    }),
  );
  assert.equal(r.ok, true);
  assert.ok(Number.isNaN(r.balanceEth));
  assert.equal(r.gasGwei, 3);
});

test('proceeds on a transient gas read error', async () => {
  const r = await preflight(
    baseDeps({
      getGasPriceWei: async () => {
        throw new Error('rpc down');
      },
    }),
  );
  assert.equal(r.ok, true);
  assert.ok(Number.isNaN(r.gasGwei));
});
