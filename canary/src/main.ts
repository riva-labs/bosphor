import { config } from 'dotenv';
import { resolve } from 'path';
config({ path: resolve(import.meta.dirname, '../../.env') });

import { createServer } from 'http';
import { ethers } from 'ethers';
import * as Sentry from '@sentry/node';
import { CanaryMetrics } from './metrics.ts';
import { runProbe, type ChainProbe } from './probe.ts';
import { createEvmProbe } from './probes/evm.ts';
import { initSentry, reportProbeFailure } from './error-report.ts';

if (initSentry(process.env.SENTRY_DSN, process.env.SENTRY_ENVIRONMENT || 'production')) {
  console.log('[canary] Sentry error reporting enabled');
}

// --- shared config ---
const PORT = Number(process.env.CANARY_PORT) || 9300;
const INTERVAL_MS = Number(process.env.CANARY_INTERVAL_MS) || 15 * 60 * 1000;
// Must stay below INTERVAL_MS. If a probe is allowed to run as long as the
// interval, a single slow round-trip overruns into the next tick, which is then
// skipped ("previous probe still in flight") -- so exactly when the return path
// is degraded we collect half the samples. A round-trip normally takes ~4 min,
// so 10 min is generous headroom while leaving slack before the tick.
const MAX_WAIT_MS = Number(process.env.CANARY_MAX_WAIT_MS) || 10 * 60 * 1000;
const DST_EID = Number(process.env.SUI_EID) || 40378;
const STORAGE_EPOCHS = Number(process.env.WALRUS_STORE_EPOCHS) || 5;
const LZ_OPTIONS = process.env.LZ_OPTIONS || '0x00030100110100000000000000000000000000030d40';
const RELAYER_URL = process.env.RELAYER_URL || 'http://relayer:3000';

if (MAX_WAIT_MS >= INTERVAL_MS) {
  console.warn(
    `[canary] CANARY_MAX_WAIT_MS (${MAX_WAIT_MS}) >= CANARY_INTERVAL_MS (${INTERVAL_MS}); ` +
      'a slow probe will overrun the next tick and skip a sample',
  );
}

const metrics = new CanaryMetrics();

/**
 * Run one preflight-guarded round-trip for a chain and publish the result to
 * Prometheus. Never throws: a probe failure is recorded and reported, not
 * propagated, so one degraded chain cannot halt the loop.
 */
async function runCycle(probe: ChainProbe): Promise<void> {
  const pre = await probe.preflight();
  if (probe.chain === 'evm') {
    metrics.setWalletBalanceEth(pre.balanceNative);
    if (pre.gasGwei !== undefined) metrics.setGasPrice(pre.gasGwei);
  } else {
    metrics.setWalletBalanceSol(pre.balanceNative);
  }
  if (!pre.ok && pre.reason) {
    metrics.recordSkip(probe.chain, pre.reason);
    console.warn(
      `[canary:${probe.chain}] skipping tick (${pre.reason}): balance ${pre.balanceNative.toFixed(4)}` +
        (pre.gasGwei !== undefined ? `, gas ${pre.gasGwei.toFixed(1)} gwei` : ''),
    );
    return;
  }

  console.log(`[canary:${probe.chain}] starting round-trip (${probe.label})`);
  const res = await runProbe(probe, { maxWaitMs: MAX_WAIT_MS });
  if (res.success) {
    metrics.recordSuccess(probe.chain, res.roundtripSeconds ?? 0, Math.floor(Date.now() / 1000));
    if (res.submitSeconds) metrics.observeStage(probe.chain, 'forward_delivery', res.submitSeconds);
    if (res.returnSeconds) metrics.observeStage(probe.chain, 'return_delivery', res.returnSeconds);
    console.log(
      `[canary:${probe.chain}] SUCCESS ${res.intentId} in ${Math.round(res.roundtripSeconds ?? 0)}s`,
    );
  } else {
    metrics.recordFailure(probe.chain);
    reportProbeFailure(Sentry, res);
    console.error(
      `[canary:${probe.chain}] FAILURE at ${res.failedStage}: ${res.error} (${res.intentId})`,
    );
  }
}

/**
 * Schedule a chain's probe: fire once immediately, then on a fixed interval,
 * with a per-chain single-flight guard so a slow round-trip cannot overlap
 * itself. Each chain runs independently, so a stalled Solana leg never blocks
 * the EVM leg.
 */
function scheduleChain(probe: ChainProbe, intervalMs: number): void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      console.log(`[canary:${probe.chain}] previous probe still in flight, skipping this tick`);
      return;
    }
    running = true;
    try {
      await runCycle(probe);
    } catch (err) {
      metrics.recordFailure(probe.chain);
      Sentry.captureException(err);
      console.error(`[canary:${probe.chain}] unexpected error: ${err}`);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), intervalMs);
}

async function buildProbes(): Promise<ChainProbe[]> {
  const probes: ChainProbe[] = [];

  // EVM probe (always on). Requires the core EVM + relayer config.
  const { EVM_RPC_URL, EVM_ADAPTER_ADDRESS, EVM_RELAYER_KEY } = process.env;
  if (!EVM_RPC_URL || !EVM_ADAPTER_ADDRESS || !EVM_RELAYER_KEY) {
    console.error('[canary] missing EVM_RPC_URL / EVM_ADAPTER_ADDRESS / EVM_RELAYER_KEY');
    process.exit(1);
  }
  probes.push(
    createEvmProbe({
      rpcUrl: EVM_RPC_URL,
      adapterAddress: EVM_ADAPTER_ADDRESS,
      privateKey: EVM_RELAYER_KEY,
      relayerUrl: RELAYER_URL,
      dstEid: DST_EID,
      storageEpochs: STORAGE_EPOCHS,
      options: LZ_OPTIONS,
      minBalanceWei: ethers.parseEther(String(Number(process.env.CANARY_MIN_BALANCE_ETH) || 0.005)),
      maxGasWei: BigInt(Math.round((Number(process.env.CANARY_MAX_GAS_GWEI) || 50) * 1e9)),
      proofLookbackBlocks: Number(process.env.CANARY_PROOF_LOOKBACK_BLOCKS) || 5000,
    }),
  );

  // Solana probe (opt-in): enabled only when SOLANA_RPC_URL is set, mirroring the
  // relayer's Solana watcher. Loaded lazily so the heavy Solana + LayerZero SDKs
  // never load in an EVM-only deployment.
  if (process.env.SOLANA_RPC_URL) {
    const keypair = process.env.SOLANA_CANARY_KEYPAIR;
    if (!keypair) {
      console.error('[canary] SOLANA_RPC_URL is set but SOLANA_CANARY_KEYPAIR is missing');
      process.exit(1);
    }
    const { createSolanaProbe } = await import('./probes/solana.ts');
    probes.push(
      await createSolanaProbe({
        rpcUrl: process.env.SOLANA_RPC_URL,
        programId: process.env.SOLANA_PROGRAM_ID || '7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF',
        keypair,
        relayerUrl: RELAYER_URL,
        dstEid: Number(process.env.SOLANA_DST_EID) || DST_EID,
        suiReceiver:
          process.env.SOLANA_SUI_RECEIVER ||
          '0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5',
        storageEpochs: STORAGE_EPOCHS,
        nativeFee: BigInt(process.env.SOLANA_NATIVE_FEE || '3000000'),
        computeUnitLimit: Number(process.env.SOLANA_CU_LIMIT) || 400_000,
        minBalanceSol: Number(process.env.SOLANA_MIN_BALANCE_SOL) || 0.05,
        endpointId:
          process.env.SOLANA_ENDPOINT_ID || '76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6',
        ulnId: process.env.SOLANA_ULN_ID || '7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH',
      }),
    );
    console.log('[canary] Solana probe enabled');
  }

  return probes;
}

async function main(): Promise<void> {
  const probes = await buildProbes();

  createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', chains: probes.map((p) => p.chain) }));
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
    console.log(
      `[canary] /metrics on :${PORT}, interval ${INTERVAL_MS / 1000}s, ` +
        `chains: ${probes.map((p) => p.chain).join(', ')}`,
    );
  });

  for (const probe of probes) scheduleChain(probe, INTERVAL_MS);
}

main().catch((err) => {
  console.error(`[canary] fatal: ${err}`);
  process.exit(1);
});
