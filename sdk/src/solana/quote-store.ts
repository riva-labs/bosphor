/**
 * Wallet-free price quote for a Solana-origin store. The live LayerZero fee is
 * read by simulating the endpoint's `quote` instruction, locally (see
 * `quoteSolanaLzFee`) or by the relayer (`GET /lz-fee/solana`), and the storage
 * (escrow) part comes from the relayer.
 */

import { resolveSolanaLzFee } from "./relayer-lz-fee.js";
import { TESTNET, type BosphorNetwork } from "../networks.js";
import { fetchQuote, resolveStoreSize, type PricedQuote, type StoreSize } from "../quote.js";
import { DEFAULT_EPOCHS, type FetchLike } from "../store-flow.js";

/** Options for {@link quoteSolanaStore}: the file (bytes or size), a connection, and the storage terms. */
export type QuoteSolanaStoreOptions = StoreSize & {
  /**
   * A `@solana/web3.js` `Connection` to the network's cluster, for the local
   * LayerZero fee quote. Optional: without it (or without the LayerZero Solana
   * SDK) the live fee comes from the relayer.
   */
  connection?: object;
  /**
   * Ask the relayer (`GET /lz-fee/solana`) for the live LayerZero fee when the
   * local quote is unavailable. Defaults to true; `false` prices the preset cap.
   */
  relayerLzFee?: boolean;
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
 * {@link PricedQuote} as `client.priceQuote()`. The LayerZero part is the live
 * fee: simulated locally when the optional peer `@layerzerolabs/lz-solana-sdk-v2`
 * is installed, otherwise read from the relayer (`GET /lz-fee/solana`), so a
 * browser gets an exact quote too. Only a relayer without that endpoint leaves
 * the preset's fee cap, flagged `forwardIsUpperBound: true`.
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

  const live = await resolveSolanaLzFee({
    network,
    connection: opts.connection,
    lzSdk: opts.lzSdk,
    web3: opts.web3,
    relayer:
      opts.relayerLzFee === false
        ? false
        : { url: network.relayerUrl, fetch: opts.fetch, signal: opts.signal, appId: opts.appId },
  });

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
