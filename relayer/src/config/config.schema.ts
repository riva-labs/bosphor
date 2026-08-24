import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // EVM
  EVM_RPC_URL: Joi.string().uri().required(),
  // Private key for the EVM relayer wallet (EVM_PRIVATE_KEY)
  EVM_RELAYER_KEY: Joi.string().required(),
  EVM_ADAPTER_ADDRESS: Joi.string().required(),
  EVM_DST_EID: Joi.number().integer().default(40161),

  // Sui
  // Selects network-specific constants (e.g. the WAL coin type). Defaults to
  // testnet; set SUI_NETWORK=mainnet on the mainnet deployment.
  SUI_NETWORK: Joi.string().valid('mainnet', 'testnet').default('testnet'),
  SUI_GRPC_URL: Joi.string().uri().default('https://sui-testnet.mystenlabs.com'),
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
  // proof is confirmed on Solana rather than EVM. Solana devnet EID by default.
  SOLANA_SRC_EID: Joi.number().integer().default(40168),
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

  // App
  INTENT_TTL_MS: Joi.number().integer().default(3600000),
  PORT: Joi.number().default(3000),
  LOG_LEVEL: Joi.string().default('info'),
});
