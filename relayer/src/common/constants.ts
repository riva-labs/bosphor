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
