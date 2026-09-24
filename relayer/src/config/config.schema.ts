import * as Joi from 'joi';
import {
  MAINNET_PRESET,
  NETWORKS,
  TESTNET_PRESET,
  mainnetConsistencyErrors,
} from './network-presets';

const isMainnet = { is: 'mainnet' } as const;

/**
 * A key with a per-network default: testnet falls back to its historical value,
 * mainnet uses its canonical preset or, when there is none, must be set.
 */
function presetNumber(testnet: number, mainnet?: number): Joi.NumberSchema {
  return Joi.number()
    .integer()
    .when('NETWORK', {
      ...isMainnet,
      then: mainnet === undefined ? Joi.required() : Joi.number().default(mainnet),
      otherwise: Joi.number().default(testnet),
    });
}

function presetString(
  base: Joi.StringSchema,
  testnet: string,
  mainnet?: string,
): Joi.StringSchema {
  return base.when('NETWORK', {
    ...isMainnet,
    then: mainnet === undefined ? Joi.required() : Joi.string().default(mainnet),
    otherwise: Joi.string().default(testnet),
  });
}

export const configValidationSchema = Joi.object({
  // Network preset. testnet keeps every historical default (no behavior change
  // for a deployment that never sets NETWORK); mainnet has no testnet fallbacks,
  // so chain-specific values must be set explicitly or startup fails.
  NETWORK: Joi.string()
    .valid(...NETWORKS)
    .default('testnet'),

  // EVM
  EVM_RPC_URL: Joi.string().uri().required(),
  // Private key for the EVM relayer wallet (EVM_PRIVATE_KEY)
  EVM_RELAYER_KEY: Joi.string().required(),
  EVM_ADAPTER_ADDRESS: Joi.string().required(),
  // LayerZero EID of the EVM origin chain. Sepolia on testnet; required on
  // mainnet (the mainnet EVM chain is a deployment choice, not a default).
  EVM_DST_EID: presetNumber(TESTNET_PRESET.EVM_DST_EID),
  // Chain id of the network behind EVM_RPC_URL. Pinning it lets the provider
  // start with a static network instead of discovering the chain id over the
  // RPC at boot, so a flaky endpoint can never fail startup with an
  // "initial-network-discovery" timeout. Sepolia on testnet; required on mainnet.
  EVM_CHAIN_ID: presetNumber(TESTNET_PRESET.EVM_CHAIN_ID),

  // Sui
  // Selects network-specific constants (e.g. the WAL coin type). Follows NETWORK
  // by default; a mainnet config must not point it at testnet.
  SUI_NETWORK: presetString(
    Joi.string().valid('mainnet', 'testnet'),
    TESTNET_PRESET.SUI_NETWORK,
    MAINNET_PRESET.SUI_NETWORK,
  ),
  // Sui fullnode gRPC endpoint. Public testnet node on testnet; required on mainnet.
  SUI_GRPC_URL: presetString(Joi.string().uri(), TESTNET_PRESET.SUI_GRPC_URL),
  SUI_RELAYER_KEY: Joi.string().required(),
  SUI_PACKAGE_ID: Joi.string().required(),
  SUI_CONFIG_ID: Joi.string().required(),
  // Walrus System shared object. Required by the M3 execute_store PTB, which
  // takes the System object to bind the stored blob to the on-chain commitment.
  SUI_WALRUS_SYSTEM_ID: Joi.string().required(),
  SUI_LZ_PACKAGE_ID: Joi.string().optional().allow(''),
  SUI_LZ_CONFIG_ID: Joi.string().optional().allow(''),
  SUI_LZ_OAPP_ID: Joi.string().optional().allow(''),
  SUI_LZ_MESSAGING_CHANNEL: Joi.string().optional().allow(''),

  // LZ v2 infrastructure (Sui testnet shared objects)
  SUI_LZ_ENDPOINT_V2: Joi.string().optional().allow(''),
  SUI_LZ_ENDPOINT_V2_OBJ: Joi.string().optional().allow(''),
  SUI_LZ_ULN302: Joi.string().optional().allow(''),
  SUI_LZ_ULN302_OBJ: Joi.string().optional().allow(''),
  SUI_LZ_EXECUTOR_PKG: Joi.string().optional().allow(''),
  SUI_LZ_EXECUTOR_OBJ: Joi.string().optional().allow(''),
  SUI_LZ_EXEC_FEE_LIB: Joi.string().optional().allow(''),
  SUI_LZ_EXEC_FEE_LIB_OBJ: Joi.string().optional().allow(''),
  SUI_LZ_DVN_PKG: Joi.string().optional().allow(''),
  SUI_LZ_DVN_OBJ: Joi.string().optional().allow(''),
  SUI_LZ_DVN_FEE_LIB: Joi.string().optional().allow(''),
  SUI_LZ_DVN_FEE_LIB_OBJ: Joi.string().optional().allow(''),
  SUI_LZ_PRICE_FEED: Joi.string().optional().allow(''),
  SUI_LZ_PRICE_FEED_OBJ: Joi.string().optional().allow(''),
  SUI_LZ_TREASURY: Joi.string().optional().allow(''),
  SUI_LZ_TREASURY_OBJ: Joi.string().optional().allow(''),

  // Solana-origin support (M3 #242). When both SOLANA_RPC_URL and
  // SOLANA_PROGRAM_ID are set, the relayer watches the Solana adapter's
  // IntentSubmitted events and records their commitment, so ingest and
  // execute_store work for Solana-origin intents. Unset on the EVM-only
  // deployment, where the Solana watcher stays inert.
  SOLANA_RPC_URL: Joi.string().uri().optional().allow(''),
  SOLANA_PROGRAM_ID: Joi.string().optional().allow(''),
  // Sui address that receives the stored blob for a Solana-origin intent. A
  // Solana pubkey cannot own a Sui object, so the M3 single-relayer model routes
  // the blob to this address, defaulting to the relayer's own Sui address.
  SOLANA_SUI_RECIPIENT: Joi.string().optional().allow(''),
  // Origin endpoint id that identifies a Solana-origin intent, so its return
  // proof is confirmed on Solana rather than EVM. Solana devnet EID on testnet,
  // the canonical Solana mainnet EID (30168) on mainnet.
  SOLANA_SRC_EID: presetNumber(TESTNET_PRESET.SOLANA_SRC_EID, MAINNET_PRESET.SOLANA_SRC_EID),
  // Store-admin keypair (inline JSON secret-key array or a path to one) used to
  // sign the Solana return leg confirm_execution. Unset disables the return leg.
  SOLANA_RELAYER_KEYPAIR: Joi.string().optional().allow(''),

  // Walrus
  WALRUS_RELAY_URL: Joi.string().uri().required(),
  WALRUS_STORE_EPOCHS: Joi.number().default(5),

  // WAL auto top-up: the relayer refills its own WAL (Walrus storage token) by
  // swapping SUI on the Walrus testnet exchange when the balance runs low.
  WAL_MIN_BALANCE_MIST: Joi.number().integer().default(500_000_000), // 0.5 WAL floor
  WAL_TOPUP_SUI_MIST: Joi.number().integer().default(1_000_000_000), // swap 1 SUI per top-up
  WAL_TOPUP_SUI_RESERVE_MIST: Joi.number().integer().default(1_000_000_000), // keep >=1 SUI for gas

  // Public intent feed / dashboard
  // Postgres connection for the IntentLifecycleStore. When unset, the relayer
  // falls back to an in-memory store (local dev / tests only; not durable).
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .optional()
    .allow(''),
  // Origin allowed to read the public API (CORS). The deployed dashboard.
  DASHBOARD_ORIGIN: Joi.string().uri().default('https://status.bosphor.xyz'),

  // Observability: Sentry runtime error tracking. When SENTRY_DSN is unset,
  // error reporting is disabled (the relayer runs unchanged).
  SENTRY_DSN: Joi.string().uri().optional().allow(''),
  SENTRY_ENVIRONMENT: Joi.string().default('production'),

  // M3 out-of-band ingest: absolute upper bound on an ingested blob, an
  // early safety cap before the exact committed-size check. Rejects an
  // oversized upload with a distinct reason (413) rather than allocating it.
  MAX_INGEST_BLOB_BYTES: Joi.number().integer().default(10485760), // 10 MiB

  // Aggregate backpressure ceiling for the durable store queue: total bytes held
  // across all staged (not-yet-stored) intents. Over this, ingest sheds load with
  // a 503 + Retry-After instead of buffering unbounded (the OOM guard). Only
  // enforced when DATABASE_URL is set (the durable queue is active).
  MAX_STAGED_BYTES: Joi.number().integer().default(268435456), // 256 MiB

  // Durable store queue processing knobs (single-writer loop).
  // How many intents the loop stores in parallel per tick.
  STORE_CONCURRENCY: Joi.number().integer().min(1).default(4),
  // Rows scanned per claim tick (an upper bound on per-tick work).
  STORE_BATCH_SIZE: Joi.number().integer().min(1).default(20),
  // Exponential backoff for a failed store attempt: min(BASE * 2^attempts, CAP).
  STORE_BACKOFF_BASE_MS: Joi.number().integer().default(2000),
  STORE_BACKOFF_CAP_MS: Joi.number().integer().default(300000), // 5 min
  // Pre-store attempts (blob not yet on Walrus+Sui) before dead-lettering.
  MAX_STORE_ATTEMPTS: Joi.number().integer().min(1).default(8),
  // Return-leg attempts (blob already stored) before alerting. The storage is
  // safe, so this never dead-letters; it keeps retrying and raises a metric.
  RETURN_MAX_ATTEMPTS: Joi.number().integer().min(1).default(20),
  // Upper bound on one store attempt; a hung Walrus/Sui call is aborted and the
  // row rescheduled instead of pinning the in-process slot forever.
  STORE_ATTEMPT_TIMEOUT_MS: Joi.number().integer().default(120000), // 2 min
  // Claim lease duration (single-writer enforcement). A drained row is exclusive
  // to the claiming process until the lease expires; the owner renews implicitly
  // every claim tick by re-draining its own rows, so this only has to cover the
  // window between a process crash and takeover, never a whole store. Kept
  // generous (5x STORE_ATTEMPT_TIMEOUT_MS) so a live-but-slow store attempt is
  // never taken over mid-flight even if the claim loop stalls for minutes.
  STORE_LEASE_MS: Joi.number().integer().min(1).default(600000), // 10 min
  // Retention window for terminal rows (done/dead/expired). The reaper purges
  // rows older than this so the queue table does not grow without bound; the
  // durable evidence they carry lives in the intent_lifecycle feed regardless.
  STAGED_RETENTION_MS: Joi.number().integer().default(86400000), // 24 h
  // Graceful-shutdown drain budget. On SIGTERM the processor waits up to this
  // long for in-flight stores to settle before exiting; anything still active
  // resumes idempotently on next boot (no re-upload / re-record).
  SHUTDOWN_DRAIN_MS: Joi.number().integer().default(30000), // 30 s

  // Pricing + never-lose-money gate.
  // Sui -> origin return-leg LayerZero fee estimate (MIST) used by the quote and
  // the break-even recompute. The testnet default is testnet-calibrated; on
  // mainnet it must be measured and set explicitly.
  QUOTE_RETURN_LZ_FEE_MIST: presetString(
    Joi.string().pattern(/^\d+$/),
    TESTNET_PRESET.QUOTE_RETURN_LZ_FEE_MIST,
  ),
  // Break-even guard ('true' enables). Off on testnet, on by default on mainnet.
  BREAK_EVEN_GUARD_ENABLED: presetString(
    Joi.string(),
    TESTNET_PRESET.BREAK_EVEN_GUARD_ENABLED,
    MAINNET_PRESET.BREAK_EVEN_GUARD_ENABLED,
  ),

  // App
  INTENT_TTL_MS: Joi.number().integer().default(3600000),
  PORT: Joi.number().default(3000),
  LOG_LEVEL: Joi.string().default('info'),
}).custom((value: Record<string, unknown>, helpers) => {
  // Cross-field sanity for mainnet: catch a testnet value copied into a mainnet
  // config (a 40xxx EID, the Sepolia chain id, a testnet RPC URL) at startup.
  if (value.NETWORK !== 'mainnet') return value;
  const errors = mainnetConsistencyErrors(value);
  if (errors.length > 0) {
    return helpers.message({
      custom: `NETWORK=mainnet config is inconsistent: ${errors.join('; ')}`,
    });
  }
  return value;
});
