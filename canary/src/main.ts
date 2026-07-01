import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(import.meta.dirname, '../../.env') });

import { createServer } from 'http';
import { ethers } from 'ethers';
import { CanaryMetrics } from './metrics.ts';
import { runProbe, type ProbeDeps } from './probe.ts';
import { preflight } from './preflight.ts';

const EVM_RPC_URL = process.env.EVM_RPC_URL;
const EVM_ADAPTER_ADDRESS = process.env.EVM_ADAPTER_ADDRESS;
const EVM_RELAYER_KEY = process.env.EVM_RELAYER_KEY;

for (const [k, v] of Object.entries({ EVM_RPC_URL, EVM_ADAPTER_ADDRESS, EVM_RELAYER_KEY })) {
  if (!v) {
    console.error(`[canary] missing ${k} in environment`);
    process.exit(1);
  }
}

const DST_EID = Number(process.env.SUI_EID) || 40378;
const LZ_OPTIONS = '0x00030100110100000000000000000000000000030d40';
const INTERVAL_MS = Number(process.env.CANARY_INTERVAL_MS) || 15 * 60 * 1000;
const PORT = Number(process.env.CANARY_PORT) || 9300;
const POLL_INTERVAL_MS = Number(process.env.CANARY_POLL_INTERVAL_MS) || 15_000;
// Must stay below INTERVAL_MS. If a probe is allowed to run as long as the
// interval, a single slow round-trip overruns into the next tick, which is then
// skipped ("previous probe still in flight") -- so exactly when the return path
// is degraded we collect half the samples. A round-trip normally takes ~4 min,
// so 10 min is generous headroom while leaving 5 min of slack before the tick.
const MAX_WAIT_MS = Number(process.env.CANARY_MAX_WAIT_MS) || 10 * 60 * 1000;
const DEADLINE_SECONDS = Number(process.env.CANARY_DEADLINE_SECONDS) || 14_400;

// Preflight guard thresholds. Skip a probe rather than burn (or fail on) a paid
// tx when the wallet is nearly drained or gas has spiked. Both are drains we hit
// in production: an empty sender and a Sepolia base-fee spike to 400+ gwei.
const MIN_BALANCE_ETH = Number(process.env.CANARY_MIN_BALANCE_ETH) || 0.005;
const MAX_GAS_GWEI = Number(process.env.CANARY_MAX_GAS_GWEI) || 50;
const MIN_BALANCE_WEI = ethers.parseEther(String(MIN_BALANCE_ETH));
const MAX_GAS_WEI = BigInt(Math.round(MAX_GAS_GWEI * 1e9));

if (MAX_WAIT_MS >= INTERVAL_MS) {
  console.warn(
    `[canary] CANARY_MAX_WAIT_MS (${MAX_WAIT_MS}) >= CANARY_INTERVAL_MS (${INTERVAL_MS}); ` +
      'a slow probe will overrun the next tick and skip a sample',
  );
}

const ADAPTER_ABI = [
  'function nonces(address) view returns (uint256)',
  'function executed(bytes32) view returns (bool)',
  'function quote(uint32 dstEid, bytes payload, uint256 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
  'function submitIntent(uint32 dstEid, bytes payload, uint256 deadline, bytes options) payable returns (bytes32)',
];

const provider = new ethers.JsonRpcProvider(EVM_RPC_URL, undefined, { staticNetwork: true });
const wallet = new ethers.Wallet(EVM_RELAYER_KEY as string, provider);
const adapter = new ethers.Contract(EVM_ADAPTER_ADDRESS as string, ADAPTER_ABI, wallet);

const metrics = new CanaryMetrics();

function makeDeps(): ProbeDeps {
  return {
    sender: wallet.address,
    dstEid: DST_EID,
    options: LZ_OPTIONS,
    deadlineSecondsFromNow: DEADLINE_SECONDS,
    pollIntervalMs: POLL_INTERVAL_MS,
    maxWaitMs: MAX_WAIT_MS,
    buildPayload: () => ethers.toUtf8Bytes(`bosphor-canary-${Date.now()}`),
    getNonce: (s) => adapter.nonces(s),
    quoteFee: async (dstEid, payload, deadline, options) =>
      (await adapter.quote(dstEid, payload, deadline, options)).nativeFee,
    submitIntent: async (dstEid, payload, deadline, options, value) => {
      const tx = await adapter.submitIntent(dstEid, payload, deadline, options, { value });
      await tx.wait();
    },
    isExecuted: (id) => adapter.executed(id),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

let running = false;

async function runOnce(): Promise<void> {
  if (running) {
    console.log('[canary] previous probe still in flight, skipping this tick');
    return;
  }
  running = true;
  try {
    // Guard the paid submit: skip this tick if the wallet is nearly drained or
    // gas has spiked, and always refresh the balance/gas gauges for Prometheus.
    const pre = await preflight({
      getBalanceWei: () => provider.getBalance(wallet.address),
      getGasPriceWei: async () => {
        const fee = await provider.getFeeData();
        return fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
      },
      minBalanceWei: MIN_BALANCE_WEI,
      maxGasWei: MAX_GAS_WEI,
    });
    metrics.setWalletBalance(pre.balanceEth);
    metrics.setGasPrice(pre.gasGwei);
    if (!pre.ok && pre.reason) {
      metrics.recordSkip(pre.reason);
      console.warn(
        `[canary] skipping tick (${pre.reason}): balance ${pre.balanceEth.toFixed(4)} ETH, ` +
          `gas ${pre.gasGwei.toFixed(1)} gwei`,
      );
      return;
    }

    console.log(`[canary] starting round-trip from ${wallet.address} (dstEid ${DST_EID})`);
    const res = await runProbe(makeDeps());
    if (res.success) {
      metrics.recordSuccess(res.roundtripSeconds ?? 0, Math.floor(Date.now() / 1000));
      if (res.submitSeconds) metrics.observeStage('forward_delivery', res.submitSeconds);
      if (res.returnSeconds) metrics.observeStage('return_delivery', res.returnSeconds);
      console.log(
        `[canary] SUCCESS ${res.intentId} in ${Math.round(res.roundtripSeconds ?? 0)}s`,
      );
    } else {
      metrics.recordFailure();
      console.error(`[canary] FAILURE at ${res.failedStage}: ${res.error} (${res.intentId})`);
    }
  } catch (err) {
    metrics.recordFailure();
    console.error(`[canary] unexpected error: ${err}`);
  } finally {
    running = false;
  }
}

createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sender: wallet.address }));
    return;
  }
  if (req.url === '/metrics') {
    metrics
      .getMetrics()
      .then((body) => {
        res.writeHead(200, { 'Content-Type': metrics.contentType });
        res.end(body);
      })
      .catch((err) => {
        res.writeHead(500);
        res.end(String(err));
      });
    return;
  }
  res.writeHead(404);
  res.end('not found');
}).listen(PORT, () => {
  console.log(`[canary] /metrics on :${PORT}, interval ${INTERVAL_MS / 1000}s`);
});

// Fire one round-trip immediately, then on a fixed interval.
void runOnce();
setInterval(() => void runOnce(), INTERVAL_MS);
