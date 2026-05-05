import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  // EVM
  EVM_RPC_URL: Joi.string().uri().required(),
  // Private key for the EVM relayer wallet (EVM_PRIVATE_KEY)
  EVM_RELAYER_KEY: Joi.string().required(),
  EVM_ADAPTER_ADDRESS: Joi.string().required(),

  // Sui
  SUI_RPC_URL: Joi.string()
    .uri()
    .default('https://fullnode.testnet.sui.io:443'),
  SUI_RELAYER_KEY: Joi.string().required(),
  SUI_PACKAGE_ID: Joi.string().required(),
  SUI_CONFIG_ID: Joi.string().required(),
  SUI_LZ_PACKAGE_ID: Joi.string().optional().allow(''),

  // Walrus
  WALRUS_PUBLISHER_URL: Joi.string().uri().required(),
  WALRUS_AGGREGATOR_URL: Joi.string().uri().required(),
  WALRUS_STORE_EPOCHS: Joi.number().default(5),

  // App
  PORT: Joi.number().default(3000),
  LOG_LEVEL: Joi.string().default('info'),
});
