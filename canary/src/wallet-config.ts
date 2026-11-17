import { readFileSync } from 'fs';

/** Chains the wallet watcher can read (and, on test networks, top up). */
export type WalletChain = 'sui' | 'evm' | 'solana';

const CHAINS: readonly WalletChain[] = ['sui', 'evm', 'solana'];

/** The native coin type on Sui. Only native coins are ever topped up. */
export const SUI_COIN_TYPE = '0x2::sui::SUI';

/**
 * One watched service wallet, resolved from the WALLET_WATCH config.
 *
 * `floor` and `target` (whole-token units) opt the wallet into the testnet
 * auto top-up: below `floor` it is refilled up to `target`, at most `dailyCap`
 * per rolling 24h. Without both it is watched (metrics only).
 */
export interface WatchedWallet {
  chain: WalletChain;
  /** Network label as configured (e.g. testnet, devnet, sepolia, mainnet). */
  network: string;
  address: string;
  role: string;
  /** Sui coin type for non-SUI coins (e.g. WAL). Undefined for the native coin. */
  coinType?: string;
  /** Short coin symbol used as the `coin` metric label (SUI, WAL, ETH, SOL). */
  coin: string;
  /** Decimals used to convert base units to whole tokens. */
  decimals: number;
  floor?: number;
  target?: number;
  dailyCap?: number;
}

/** True when the wallet holds the chain's native gas coin (the only coin we top up). */
export function isNativeCoin(w: WatchedWallet): boolean {
  return w.coinType === undefined || w.coinType === SUI_COIN_TYPE;
}

function nativeSymbol(chain: WalletChain): string {
  return chain === 'sui' ? 'SUI' : chain === 'evm' ? 'ETH' : 'SOL';
}

function nativeDecimals(chain: WalletChain): number {
  return chain === 'evm' ? 18 : 9;
}

function optionalNumber(raw: unknown, field: string, idx: number): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    throw new Error(`WALLET_WATCH[${idx}].${field} must be a non-negative number`);
  }
  return n;
}

function requiredString(raw: unknown, field: string, idx: number): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`WALLET_WATCH[${idx}].${field} is required`);
  }
  return raw.trim();
}

/**
 * Parse the watch list. Accepts a JSON array of entries
 * `{chain, network, address, role, coin?, decimals?, floor?, target?, dailyCap?}`.
 *
 * For Sui, `coin` is a full coin type (e.g. the WAL type); it defaults to SUI.
 * For EVM and Solana only the native coin is supported, so `coin` is ignored.
 *
 * Throws on any malformed entry: a typo in the watch list must fail loudly at
 * startup rather than silently drop a wallet from monitoring.
 */
export function parseWalletWatch(json: string): WatchedWallet[] {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error('WALLET_WATCH must be a JSON array');

  const wallets = parsed.map((e: Record<string, unknown>, idx): WatchedWallet => {
    if (typeof e !== 'object' || e === null) throw new Error(`WALLET_WATCH[${idx}] must be an object`);
    const chain = requiredString(e.chain, 'chain', idx) as WalletChain;
    if (!CHAINS.includes(chain)) {
      throw new Error(`WALLET_WATCH[${idx}].chain must be one of ${CHAINS.join(', ')}`);
    }

    let coinType: string | undefined;
    let coin = nativeSymbol(chain);
    if (chain === 'sui' && typeof e.coin === 'string' && e.coin.trim() !== '') {
      coinType = e.coin.trim();
      coin = coinType.split('::').pop()!.toUpperCase();
    }

    const floor = optionalNumber(e.floor, 'floor', idx);
    const target = optionalNumber(e.target, 'target', idx);
    if ((floor === undefined) !== (target === undefined)) {
      throw new Error(`WALLET_WATCH[${idx}]: set both floor and target, or neither`);
    }
    if (floor !== undefined && target !== undefined && target <= floor) {
      throw new Error(`WALLET_WATCH[${idx}]: target must be greater than floor`);
    }

    return {
      chain,
      network: requiredString(e.network, 'network', idx).toLowerCase(),
      address: requiredString(e.address, 'address', idx),
      role: requiredString(e.role, 'role', idx),
      coinType: coinType === SUI_COIN_TYPE ? undefined : coinType,
      coin,
      decimals: optionalNumber(e.decimals, 'decimals', idx) ?? nativeDecimals(chain),
      floor,
      target,
      // Default cap: one full refill per day.
      dailyCap: optionalNumber(e.dailyCap, 'dailyCap', idx) ?? target,
    };
  });

  const seen = new Set<string>();
  for (const w of wallets) {
    const key = `${w.chain}:${w.address.toLowerCase()}:${w.coin}`;
    if (seen.has(key)) throw new Error(`WALLET_WATCH has a duplicate entry for ${key}`);
    seen.add(key);
  }
  return wallets;
}

/**
 * Load the watch list from WALLET_WATCH: either inline JSON (starts with `[`)
 * or a path to a JSON file. Unset or empty means no watcher.
 */
export function loadWalletWatch(spec: string | undefined): WatchedWallet[] {
  if (!spec || spec.trim() === '') return [];
  const trimmed = spec.trim();
  return parseWalletWatch(trimmed.startsWith('[') ? trimmed : readFileSync(trimmed, 'utf8'));
}
