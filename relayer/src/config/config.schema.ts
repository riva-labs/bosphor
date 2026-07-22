import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // EVM
  EVM_RPC_URL: Joi.string().uri().required(),
  // Private key for the EVM relayer wallet (EVM_PRIVATE_KEY)
  EVM_RELAYER_KEY: Joi.string().required(),
  EVM_ADAPTER_ADDRESS: Joi.string().required(),
  EVM_DST_EID: Joi.number().integer().default(40161),

  // Sui
  SUI_GRPC_URL: Joi.string().uri().default('https://sui-testnet.mystenlabs.com'),
  SUI_RELAYER_KEY: Joi.string().required(),
  SUI_PACKAGE_ID: Joi.string().required(),
  SUI_CONFIG_ID: Joi.string().required(),
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
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).optional().allow(''),
  // Origin allowed to read the public API (CORS). The deployed dashboard.
  DASHBOARD_ORIGIN: Joi.string().uri().default('https://status.bosphor.xyz'),
  // Bearer token gating GET /public/waitlist/export. When unset, export is
  // disabled (403) so registrations are never publicly enumerable.
  WAITLIST_EXPORT_TOKEN: Joi.string().optional().allow(''),

  // Observability: Sentry runtime error tracking. When SENTRY_DSN is unset,
  // error reporting is disabled (the relayer runs unchanged).
  SENTRY_DSN: Joi.string().uri().optional().allow(''),
  SENTRY_ENVIRONMENT: Joi.string().default('production'),

  // App
  INTENT_TTL_MS: Joi.number().integer().default(3600000),
  PORT: Joi.number().default(3000),
  LOG_LEVEL: Joi.string().default('info'),
});
