/** Sui system clock shared object. */
export const SUI_CLOCK_OBJECT = '0x6';

/** Default LZ executor options: 200,000 gas for lzReceive on EVM. */
export const DEFAULT_LZ_OPTIONS = '0x00030100110100000000000000000000000000030d40';

/** File path for persisting the Sui checkpoint cursor between restarts. */
export const CURSOR_FILE_NAME = '.sui-checkpoint-cursor';

/** Maximum backoff (ms) for checkpoint stream reconnection. */
export const MAX_BACKOFF_MS = 30_000;

/** EVM event polling interval (ms). */
export const POLL_INTERVAL_MS = 5_000;

/** Walrus testnet WAL coin type (the token that pays for storage). */
export const WAL_COIN_TYPE =
  '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL';

/** Native SUI coin type. */
export const SUI_COIN_TYPE = '0x2::sui::SUI';

/** Walrus testnet SUI->WAL exchange package (`wal_exchange` module). */
export const WAL_EXCHANGE_PACKAGE =
  '0x82593828ed3fcb8c6a235eac9abd0adbe9c5f9bbffa9b1e7a45cdd884481ef9f';

/**
 * Walrus testnet WAL exchange shared objects, the same exchange IDs the Walrus
 * CLI (`walrus get-wal`) uses. Sourced from @mysten/walrus's
 * TESTNET_WALRUS_PACKAGE_CONFIG. Any one can be used for a swap.
 */
export const WAL_EXCHANGE_OBJECTS = [
  '0xf4d164ea2def5fe07dc573992a029e010dba09b1a8dcbc44c5c2e79567f39073',
  '0x19825121c52080bb1073662231cfea5c0e4d905fd13e95f21e9a018f2ef41862',
  '0x83b454e524c71f30803f4d6c302a86fb6a39e96cdfb873c2d1e93bc1c26a3bc5',
  '0x8d63209cf8589ce7aef8f262437163c67577ed09f3e636a9d8e0813843fb8bf1',
];

/** MIST per whole unit for both SUI and WAL (9 decimals). */
export const MIST_PER_UNIT = 1_000_000_000n;

/** Background WAL balance check / top-up interval (ms). */
export const WAL_CHECK_INTERVAL_MS = 300_000;
