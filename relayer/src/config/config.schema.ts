import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // EVM
  EVM_RPC_URL: Joi.string().uri().required(),
  // Private key for the EVM relayer wallet (EVM_PRIVATE_KEY)
  EVM_RELAYER_KEY: Joi.string().required(),
  EVM_ADAPTER_ADDRESS: Joi.string().required(),
  EVM_DST_EID: Joi.number().integer().default(30184),

  // Sui
  SUI_RPC_URL: Joi.string().uri().default('https://fullnode.mainnet.sui.io:443'),
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
  WALRUS_PUBLISHER_URL: Joi.string().uri().required(),
  WALRUS_AGGREGATOR_URL: Joi.string().uri().required(),
  WALRUS_STORE_EPOCHS: Joi.number().default(5),

  // App
  PORT: Joi.number().default(3000),
  LOG_LEVEL: Joi.string().default('info'),
});
