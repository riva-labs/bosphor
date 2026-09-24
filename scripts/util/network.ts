/**
 * Network preset for the deploy and wiring scripts, selected by
 * NETWORK=testnet|mainnet (default testnet).
 *
 * testnet keeps the exact fallbacks these scripts always used (Sepolia EVM
 * endpoint, Sepolia EID, Sui testnet EID and gRPC, public testnet JSON-RPCs), so
 * an existing testnet flow that never sets NETWORK is unchanged.
 *
 * mainnet has no testnet fallbacks. The EVM chain is a deployment parameter
 * (Ethereum, Base, Arbitrum, ...), so EVM_EID, LZ_ENDPOINT_ADDRESS and the RPC
 * URLs must be set explicitly. Only canonical LayerZero constants (the Sui
 * mainnet EID) are preset.
 */

export type BosphorNetwork = "testnet" | "mainnet";

/** Testnet-only fallbacks (the historical defaults of these scripts). */
export const TESTNET_DEFAULTS = {
  /** Sepolia LayerZero EndpointV2. */
  LZ_ENDPOINT_ADDRESS: "0x6EDCE65403992e310A62460808c4b910D972f10f",
  /** Sepolia LayerZero EID. */
  EVM_EID: "40161",
  /** Sui testnet LayerZero EID. */
  SUI_EID: "40378",
  SUI_GRPC_URL: "https://sui-testnet.mystenlabs.com",
} as const;

/** Canonical mainnet constants. Everything else is required on mainnet. */
export const MAINNET_DEFAULTS: Partial<Record<keyof typeof TESTNET_DEFAULTS, string>> = {
  /** Sui mainnet LayerZero EID. */
  SUI_EID: "30378",
};

/** Public testnet JSON-RPC fallbacks used to poll for tx finality. */
const TESTNET_SUI_JSONRPC_FALLBACKS = [
  "https://sui-testnet-rpc.publicnode.com",
  "https://rpc-testnet.suiscan.xyz",
];

export function resolveNetwork(env: NodeJS.ProcessEnv = process.env): BosphorNetwork {
  const raw = (env.NETWORK ?? "testnet").trim().toLowerCase();
  if (raw !== "testnet" && raw !== "mainnet") {
    throw new Error(`NETWORK must be "testnet" or "mainnet", got "${env.NETWORK}"`);
  }
  return raw;
}

/**
 * Resolve a preset-backed setting: the env value when set, otherwise the
 * network default. On mainnet a key without a canonical default must be set,
 * so a missing value throws instead of silently deploying against testnet.
 */
export function presetEnv(
  key: keyof typeof TESTNET_DEFAULTS,
  network: BosphorNetwork = resolveNetwork(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const v = env[key];
  if (v !== undefined && v !== "") return v;
  const fallback = network === "testnet" ? TESTNET_DEFAULTS[key] : MAINNET_DEFAULTS[key];
  if (fallback === undefined) {
    throw new Error(`${key} must be set when NETWORK=${network} (no default for this network)`);
  }
  return fallback;
}

/** Numeric variant of {@link presetEnv} for endpoint ids. */
export function presetEid(
  key: "EVM_EID" | "SUI_EID",
  network: BosphorNetwork = resolveNetwork(),
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = presetEnv(key, network, env);
  const eid = Number(raw);
  if (!Number.isInteger(eid) || eid <= 0) throw new Error(`${key}=${raw} is not a valid EID`);
  const mainnetEid = eid >= 30000 && eid < 40000;
  if (network === "mainnet" && !mainnetEid) {
    throw new Error(`${key}=${eid} is not a LayerZero mainnet EID (expected 30xxx)`);
  }
  return eid;
}

/**
 * Sui JSON-RPC endpoints to poll: SUI_JSONRPC_URL first, then the public
 * testnet nodes on testnet only. On mainnet only the explicit URL is used.
 */
export function suiJsonRpcUrls(
  network: BosphorNetwork = resolveNetwork(),
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const urls = [env.SUI_JSONRPC_URL].filter((u): u is string => !!u);
  if (network === "testnet") urls.push(...TESTNET_SUI_JSONRPC_FALLBACKS);
  if (urls.length === 0) {
    throw new Error(`SUI_JSONRPC_URL must be set when NETWORK=${network}`);
  }
  return urls;
}
