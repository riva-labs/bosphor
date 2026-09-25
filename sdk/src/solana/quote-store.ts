/**
 * Wallet-free price quote for a Solana-origin store. Needs only a `Connection`:
 * the live LayerZero fee is read by simulating the endpoint's `quote` instruction
 * (see {@link quoteSolanaLzFee}) and the storage (escrow) part comes from the
 * relayer.
 */

import { LzSolanaSdkMissingError, quoteSolanaLzFee } from "./lz-fee.js";
import { TESTNET, type BosphorNetwork } from "../networks.js";
import { fetchQuote, resolveStoreSize, type PricedQuote, type StoreSize } from "../quote.js";
import { DEFAULT_EPOCHS, type FetchLike } from "../store-flow.js";

/** Options for {@link quoteSolanaStore}: the file (bytes or size), a connection, and the storage terms. */
export type QuoteSolanaStoreOptions = StoreSize & {
  /** A `@solana/web3.js` `Connection` to the network's cluster. */
  connection: object;
  /** Storage duration in Walrus epochs; defaults to 5. */
  epochs?: number;
  /** Network preset; defaults to {@link TESTNET}. */
  network?: BosphorNetwork;
  /** `fetch` implementation for the relayer call; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Cancel the relayer call. */
  signal?: AbortSignal;
  /** Integrator attribution, sent as X-Bosphor-App (see the client `appId` option). */
  appId?: string;
  /** Inject `@layerzerolabs/lz-solana-sdk-v2`. */
  lzSdk?: object;
  /** Inject the `@solana/web3.js` module. */
  web3?: object;
};

/**
 * Price a Solana-origin store without a wallet. Returns the same
 * {@link PricedQuote} as `client.priceQuote()`. If the optional peer
 * `@layerzerolabs/lz-solana-sdk-v2` is not installed, the LayerZero part is the
 * preset's fee cap and the quote is flagged `forwardIsUpperBound: true`.
 *
 * @example
 * ```ts
 * import { Connection } from "@solana/web3.js";
 * import { TESTNET, quoteSolanaStore } from "@bosphor/sdk/solana";
 *
 * const quote = await quoteSolanaStore({
 *   connection: new Connection(TESTNET.solana.rpcUrl, "confirmed"),
 *   sizeBytes: 1024,
 * });
 * ```
 */
export async function quoteSolanaStore(opts: QuoteSolanaStoreOptions): Promise<PricedQuote> {
  const network = opts.network ?? TESTNET;
  const size = resolveStoreSize(opts);
  const epochs = opts.epochs ?? DEFAULT_EPOCHS;

  let live: bigint | null;
  try {
    const feeOpts: Parameters<typeof quoteSolanaLzFee>[0] = { connection: opts.connection, network };
    if (opts.lzSdk) feeOpts.lzSdk = opts.lzSdk;
    if (opts.web3) feeOpts.web3 = opts.web3;
    live = await quoteSolanaLzFee(feeOpts);
  } catch (err) {
    if (!(err instanceof LzSolanaSdkMissingError)) throw err;
    live = null;
  }

  const fetchOpts: { fetch?: FetchLike; signal?: AbortSignal; appId?: string } = {};
  if (opts.fetch) fetchOpts.fetch = opts.fetch;
  if (opts.signal) fetchOpts.signal = opts.signal;
  if (opts.appId) fetchOpts.appId = opts.appId;
  const quote = await fetchQuote(
    network.relayerUrl,
    {
      sizeBytes: size,
      epochs,
      originToken: "SOL",
      forwardLzFeeNative: live ?? network.solana.nativeFee,
    },
    fetchOpts,
  );
  return { ...quote, forwardIsUpperBound: live === null };
}
