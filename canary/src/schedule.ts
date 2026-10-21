import type { CanaryChain } from './metrics.ts';

type Env = Record<string, string | undefined>;

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;

/** Per-chain overrides of the shared CANARY_INTERVAL_MS. */
const CHAIN_INTERVAL_VARS: Partial<Record<CanaryChain, string>> = {
  // Each Solana probe pays LZ fees from a devnet wallet that can only be topped
  // up by hand, so Solana is typically run less often than EVM (#486).
  solana: 'CANARY_SOLANA_INTERVAL_MS',
};

// A probe spends fees, so a typo (negative, "30m", or a few ms) must never
// become a tight setInterval loop. Anything under a minute is rejected.
const MIN_INTERVAL_MS = 60 * 1000;

function parseInterval(raw: string | undefined): number | undefined {
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= MIN_INTERVAL_MS ? ms : undefined;
}

/**
 * The round-trip interval for one chain's probe: its per-chain override when
 * set and valid, else the shared CANARY_INTERVAL_MS, else 15 minutes.
 */
export function probeIntervalMs(chain: CanaryChain, env: Env = process.env): number {
  const shared = parseInterval(env.CANARY_INTERVAL_MS) ?? DEFAULT_INTERVAL_MS;
  const override = CHAIN_INTERVAL_VARS[chain];
  return (override && parseInterval(env[override])) || shared;
}
