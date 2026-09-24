import { configValidationSchema } from './config.schema';
import { TESTNET_PRESET } from './network-presets';

// Minimal set of always-required keys (secrets and deployment ids), identical on
// both networks, so each test only varies what the network preset controls.
const BASE = {
  EVM_RPC_URL: 'https://rpc.example.org',
  EVM_RELAYER_KEY: '0x' + '11'.repeat(32),
  EVM_ADAPTER_ADDRESS: '0x' + '22'.repeat(20),
  SUI_RELAYER_KEY: 'suiprivkey-test',
  SUI_PACKAGE_ID: '0x1',
  SUI_CONFIG_ID: '0x2',
  SUI_WALRUS_SYSTEM_ID: '0x3',
  WALRUS_RELAY_URL: 'https://upload-relay.example.org',
};

const MAINNET_REQUIRED = {
  NETWORK: 'mainnet',
  EVM_RPC_URL: 'https://eth.example.org',
  EVM_DST_EID: '30184',
  EVM_CHAIN_ID: '8453',
  SUI_GRPC_URL: 'https://fullnode.mainnet.sui.io',
  QUOTE_RETURN_LZ_FEE_MIST: '900000000',
};

// Mirrors ConfigModule.forRoot validationOptions.
function validate(env: Record<string, string>) {
  return configValidationSchema.validate(env, { allowUnknown: true, abortEarly: false });
}

describe('config schema network presets', () => {
  describe('testnet (default)', () => {
    it('keeps the historical testnet defaults when NETWORK is unset', () => {
      const { error, value } = validate(BASE);
      expect(error).toBeUndefined();
      expect(value.NETWORK).toBe('testnet');
      expect(value.EVM_DST_EID).toBe(40161);
      expect(value.EVM_CHAIN_ID).toBe(11155111);
      expect(value.SOLANA_SRC_EID).toBe(40168);
      expect(value.SUI_NETWORK).toBe('testnet');
      expect(value.SUI_GRPC_URL).toBe('https://sui-testnet.mystenlabs.com');
      expect(value.QUOTE_RETURN_LZ_FEE_MIST).toBe('1760000000');
      expect(value.BREAK_EVEN_GUARD_ENABLED).toBe('false');
    });

    it('matches the explicit NETWORK=testnet preset', () => {
      const implicit = validate(BASE).value;
      const explicit = validate({ ...BASE, NETWORK: 'testnet' }).value;
      expect(explicit).toEqual({ ...implicit, NETWORK: 'testnet' });
      expect(explicit.EVM_DST_EID).toBe(TESTNET_PRESET.EVM_DST_EID);
    });

    it('still honors explicit overrides on testnet', () => {
      const { error, value } = validate({
        ...BASE,
        EVM_DST_EID: '40245',
        EVM_CHAIN_ID: '84532',
        BREAK_EVEN_GUARD_ENABLED: 'true',
        QUOTE_RETURN_LZ_FEE_MIST: '5',
      });
      expect(error).toBeUndefined();
      expect(value.EVM_DST_EID).toBe(40245);
      expect(value.EVM_CHAIN_ID).toBe(84532);
      expect(value.BREAK_EVEN_GUARD_ENABLED).toBe('true');
      expect(value.QUOTE_RETURN_LZ_FEE_MIST).toBe('5');
    });

    it('rejects an unknown NETWORK', () => {
      const { error } = validate({ ...BASE, NETWORK: 'devnet' });
      expect(error?.message).toMatch(/NETWORK/);
    });
  });

  describe('mainnet', () => {
    it('accepts a complete mainnet config and applies mainnet presets', () => {
      const { error, value } = validate({ ...BASE, ...MAINNET_REQUIRED });
      expect(error).toBeUndefined();
      expect(value.EVM_DST_EID).toBe(30184);
      expect(value.EVM_CHAIN_ID).toBe(8453);
      expect(value.SOLANA_SRC_EID).toBe(30168);
      expect(value.SUI_NETWORK).toBe('mainnet');
      expect(value.BREAK_EVEN_GUARD_ENABLED).toBe('true');
    });

    it('is chain-agnostic: any mainnet EVM chain works when set explicitly', () => {
      for (const [eid, chainId] of [
        ['30101', '1'],
        ['30110', '42161'],
        ['30184', '8453'],
      ]) {
        const { error } = validate({
          ...BASE,
          ...MAINNET_REQUIRED,
          EVM_DST_EID: eid,
          EVM_CHAIN_ID: chainId,
        });
        expect(error).toBeUndefined();
      }
    });

    it.each(['EVM_DST_EID', 'EVM_CHAIN_ID', 'SUI_GRPC_URL', 'QUOTE_RETURN_LZ_FEE_MIST'])(
      'fails startup when %s is missing (no testnet fallback)',
      (key) => {
        const env: Record<string, string> = { ...BASE, ...MAINNET_REQUIRED };
        delete env[key];
        const { error } = validate(env);
        expect(error).toBeDefined();
        expect(error?.message).toContain(key);
      },
    );

    it('lets the operator explicitly disable the break-even guard', () => {
      const { value } = validate({
        ...BASE,
        ...MAINNET_REQUIRED,
        BREAK_EVEN_GUARD_ENABLED: 'false',
      });
      expect(value.BREAK_EVEN_GUARD_ENABLED).toBe('false');
    });

    it('rejects testnet values copied into a mainnet config', () => {
      const { error } = validate({
        ...BASE,
        ...MAINNET_REQUIRED,
        EVM_DST_EID: '40161',
        EVM_CHAIN_ID: '11155111',
      });
      expect(error?.message).toMatch(/not a LayerZero mainnet EID/);
      expect(error?.message).toMatch(/Sepolia/);
    });

    it('rejects a known EID paired with the wrong chain id', () => {
      const { error } = validate({ ...BASE, ...MAINNET_REQUIRED, EVM_CHAIN_ID: '1' });
      expect(error?.message).toMatch(/Base \(chain id 8453\)/);
    });

    it('rejects SUI_NETWORK=testnet under NETWORK=mainnet', () => {
      const { error } = validate({ ...BASE, ...MAINNET_REQUIRED, SUI_NETWORK: 'testnet' });
      expect(error?.message).toMatch(/SUI_NETWORK=testnet/);
    });

    it('rejects testnet-looking RPC endpoints', () => {
      const { error } = validate({
        ...BASE,
        ...MAINNET_REQUIRED,
        SUI_GRPC_URL: 'https://sui-testnet.mystenlabs.com',
        SOLANA_RPC_URL: 'https://api.devnet.solana.com',
      });
      expect(error?.message).toMatch(/SUI_GRPC_URL \(host sui-testnet\.mystenlabs\.com\)/);
      expect(error?.message).toMatch(/SOLANA_RPC_URL \(host api\.devnet\.solana\.com\)/);
    });

    it('never echoes a provider API key from a rejected RPC URL', () => {
      const { error } = validate({
        ...BASE,
        ...MAINNET_REQUIRED,
        EVM_RPC_URL: 'https://eth-sepolia.g.alchemy.com/v2/SECRETKEY123',
      });
      expect(error?.message).toMatch(/EVM_RPC_URL/);
      expect(error?.message).not.toMatch(/SECRETKEY123/);
    });
  });
});
