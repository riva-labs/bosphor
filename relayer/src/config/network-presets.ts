/**
 * Network presets for the relayer, selected by NETWORK=testnet|mainnet.
 *
 * testnet: every value keeps the exact default the relayer shipped with before
 * presets existed, so a testnet deployment that never sets NETWORK behaves
 * identically.
 *
 * mainnet: there are NO testnet fallbacks. Anything chain-specific that is not a
 * canonical LayerZero constant must be set explicitly, otherwise config
 * validation fails at startup with a clear error. The EVM origin chain is not
 * fixed (Ethereum, Base, Arbitrum, ...), so EVM_DST_EID and EVM_CHAIN_ID are
 * always explicit on mainnet.
 */

export type BosphorNetwork = 'testnet' | 'mainnet';

export const NETWORKS: readonly BosphorNetwork[] = ['testnet', 'mainnet'] as const;

/** Defaults applied when NETWORK=testnet (the historical relayer defaults). */
export const TESTNET_PRESET = {
  /** Sepolia LayerZero endpoint id. */
  EVM_DST_EID: 40161,
  /** Sepolia chain id. */
  EVM_CHAIN_ID: 11155111,
  /** Solana devnet LayerZero endpoint id. */
  SOLANA_SRC_EID: 40168,
  SUI_NETWORK: 'testnet',
  SUI_GRPC_URL: 'https://sui-testnet.mystenlabs.com',
  /** Sui -> origin return-leg LayerZero fee estimate, calibrated on testnet. */
  QUOTE_RETURN_LZ_FEE_MIST: '1760000000',
  BREAK_EVEN_GUARD_ENABLED: 'false',
} as const;

/**
 * Defaults applied when NETWORK=mainnet. Only canonical protocol constants and
 * safety defaults live here; nothing is borrowed from testnet.
 */
export const MAINNET_PRESET = {
  /** Solana mainnet LayerZero endpoint id (canonical). */
  SOLANA_SRC_EID: 30168,
  SUI_NETWORK: 'mainnet',
  /** The never-lose-money gate is on by default with real funds at stake. */
  BREAK_EVEN_GUARD_ENABLED: 'true',
} as const;

/** Keys that have no default on mainnet and must be set explicitly. */
export const MAINNET_REQUIRED_KEYS = [
  'EVM_DST_EID',
  'EVM_CHAIN_ID',
  'SUI_GRPC_URL',
  'QUOTE_RETURN_LZ_FEE_MIST',
] as const;

/**
 * Known LayerZero v2 mainnet EVM endpoints and their chain ids. Not exhaustive:
 * an EID outside this table is accepted on mainnet as long as it is in the
 * mainnet EID range, but an EID in the table must be paired with its chain id.
 */
export const KNOWN_MAINNET_EVM_CHAINS: Record<number, { chainId: number; name: string }> = {
  30101: { chainId: 1, name: 'Ethereum' },
  30184: { chainId: 8453, name: 'Base' },
  30110: { chainId: 42161, name: 'Arbitrum' },
  30111: { chainId: 10, name: 'Optimism' },
};

/** Well-known EVM testnet chain ids that must never appear in a mainnet config. */
export const KNOWN_TESTNET_EVM_CHAIN_IDS: Record<number, string> = {
  11155111: 'Sepolia',
  84532: 'Base Sepolia',
  421614: 'Arbitrum Sepolia',
  11155420: 'Optimism Sepolia',
  17000: 'Holesky',
};

/** LayerZero v2 mainnet EIDs are 30xxx; testnet EIDs are 40xxx. */
export function isMainnetEid(eid: number): boolean {
  return eid >= 30000 && eid < 40000;
}

/** URL substrings that betray a non-mainnet endpoint. */
function urlHost(v: string): string {
  try {
    return new URL(v).host;
  } catch {
    return '<unparseable url>';
  }
}

const TESTNET_URL_MARKERS = ['testnet', 'devnet', 'sepolia', 'holesky'];

export function looksLikeTestnetUrl(url: string): boolean {
  const u = url.toLowerCase();
  return TESTNET_URL_MARKERS.some((m) => u.includes(m));
}

/**
 * Cross-field checks for a mainnet config, run after per-key validation.
 * Returns human-readable problems; empty means the config is consistent. Kept
 * pure so it is unit-testable without Joi.
 */
export function mainnetConsistencyErrors(cfg: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const eid = Number(cfg.EVM_DST_EID);
  const chainId = Number(cfg.EVM_CHAIN_ID);

  if (Number.isFinite(eid) && !isMainnetEid(eid)) {
    errors.push(`EVM_DST_EID=${eid} is not a LayerZero mainnet EID (expected 30xxx)`);
  }
  if (Number.isFinite(chainId) && KNOWN_TESTNET_EVM_CHAIN_IDS[chainId]) {
    errors.push(
      `EVM_CHAIN_ID=${chainId} is ${KNOWN_TESTNET_EVM_CHAIN_IDS[chainId]}, a testnet chain`,
    );
  }
  const known = KNOWN_MAINNET_EVM_CHAINS[eid];
  if (known && Number.isFinite(chainId) && known.chainId !== chainId) {
    errors.push(
      `EVM_DST_EID=${eid} is ${known.name} (chain id ${known.chainId}) but EVM_CHAIN_ID=${chainId}`,
    );
  }

  const solanaEid = Number(cfg.SOLANA_SRC_EID);
  if (Number.isFinite(solanaEid) && !isMainnetEid(solanaEid)) {
    errors.push(`SOLANA_SRC_EID=${solanaEid} is not a LayerZero mainnet EID (expected 30xxx)`);
  }

  if (cfg.SUI_NETWORK !== 'mainnet') {
    errors.push(`SUI_NETWORK=${String(cfg.SUI_NETWORK)} but NETWORK=mainnet`);
  }

  for (const key of ['EVM_RPC_URL', 'SUI_GRPC_URL', 'SOLANA_RPC_URL', 'WALRUS_RELAY_URL']) {
    const v = cfg[key];
    if (typeof v === 'string' && v !== '' && looksLikeTestnetUrl(v)) {
      // Host only: provider URLs often carry an API key in the path or query.
      errors.push(`${key} (host ${urlHost(v)}) looks like a testnet/devnet endpoint`);
    }
  }
  return errors;
}
