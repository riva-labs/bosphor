import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ethers } from 'ethers';
import type { ChaosDeps } from './deps.ts';
import { parseCanarySkipCount } from './metrics-parse.ts';

const exec = promisify(execFile);

const ADAPTER_ABI = [
  'function nonces(address) view returns (uint256)',
  'function executed(bytes32) view returns (bool)',
  'function quote(uint32 dstEid, bytes payload, uint256 deadline, bytes options) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))',
  'function submitIntent(uint32 dstEid, bytes payload, uint256 deadline, bytes options) payable returns (bytes32)',
];

const LZ_OPTIONS = '0x00030100110100000000000000000000000000030d40';

/**
 * Deterministic intent id, matching the adapter's
 * keccak256(abi.encodePacked(sender, dstEid, payload, nonce, deadline)).
 */
function computeIntentId(
  sender: string,
  dstEid: number,
  payload: Uint8Array,
  nonce: bigint,
  deadline: number,
): string {
  return ethers.keccak256(
    ethers.solidityPacked(
      ['address', 'uint64', 'bytes', 'uint256', 'uint256'],
      [sender, dstEid, payload, nonce, deadline],
    ),
  );
}

/**
 * Read a required fault-injection command from the environment. Fault injection
 * is host-specific (systemd, docker, iptables), so the operator supplies the
 * exact command per action. A missing command fails loudly rather than silently
 * pretending the fault was injected.
 */
function requireCmd(envVar: string): string {
  const cmd = process.env[envVar];
  if (!cmd) {
    throw new Error(
      `${envVar} is not set. Configure it with the command that performs this fault injection ` +
        `on your host (see chaos/README or the docs).`,
    );
  }
  return cmd;
}

async function runShell(cmd: string, ...args: string[]): Promise<string> {
  const full = [cmd, ...args].join(' ');
  const { stdout } = await exec('bash', ['-lc', full]);
  return stdout.trim();
}

/**
 * Build the real ChaosDeps against the live testnet deployment. Chain reads and
 * intent submission go through ethers; fault-injection actions dispatch to
 * operator-supplied shell commands; canary observations come from its /metrics.
 */
export function makeRealDeps(): ChaosDeps {
  const rpcUrl = requireEnv('EVM_RPC_URL');
  const adapterAddress = requireEnv('EVM_ADAPTER_ADDRESS');
  const key = requireEnv('EVM_RELAYER_KEY');
  const dstEid = Number(process.env.SUI_EID) || 40378;
  const deadlineSeconds = Number(process.env.CHAOS_DEADLINE_SECONDS) || 14_400;
  const canaryMetricsUrl = process.env.CANARY_METRICS_URL || 'http://localhost:9300/metrics';

  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const wallet = new ethers.Wallet(key, provider);
  const adapter = new ethers.Contract(adapterAddress, ADAPTER_ABI, wallet);

  return {
    log: (msg) => console.log(msg),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),

    async submitIntent(opts) {
      const payload = ethers.toUtf8Bytes(`bosphor-chaos-${Date.now()}`);
      const deadline =
        Math.floor(Date.now() / 1000) + (opts?.deadlineSecondsFromNow ?? deadlineSeconds);
      const nonce: bigint = await adapter.nonces(wallet.address);
      const intentId = computeIntentId(wallet.address, dstEid, payload, nonce, deadline);
      const fee = (await adapter.quote(dstEid, payload, deadline, LZ_OPTIONS)).nativeFee;
      const tx = await adapter.submitIntent(dstEid, payload, deadline, LZ_OPTIONS, { value: fee });
      await tx.wait();
      return { intentId };
    },
    isFulfilled: (intentId) => adapter.executed(intentId),

    stopRelayer: () => runShell(requireCmd('CHAOS_STOP_RELAYER_CMD')).then(() => undefined),
    startRelayer: () => runShell(requireCmd('CHAOS_START_RELAYER_CMD')).then(() => undefined),
    setChainRpc: (chain, up) =>
      runShell(
        requireCmd(`CHAOS_${chain.toUpperCase()}_RPC_${up ? 'UP' : 'DOWN'}_CMD`),
      ).then(() => undefined),

    getWalBalanceMist: async () => BigInt(await runShell(requireCmd('CHAOS_WAL_BALANCE_CMD'))),
    drainWalTo: (mist) => runShell(requireCmd('CHAOS_DRAIN_WAL_CMD'), String(mist)).then(() => undefined),
    forceWalrusEpochRollover: () =>
      runShell(requireCmd('CHAOS_WALRUS_ROLLOVER_CMD')).then(() => undefined),

    setGasPriceGwei: (gwei) =>
      runShell(requireCmd('CHAOS_SET_GAS_CMD'), String(gwei)).then(() => undefined),
    getCanarySkipCount: async () => {
      const res = await fetch(canaryMetricsUrl);
      if (!res.ok) throw new Error(`canary /metrics returned ${res.status}`);
      return parseCanarySkipCount(await res.text());
    },
  };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing ${name} in environment`);
  return v;
}
