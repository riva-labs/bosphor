/**
 * Wallet-free price quote for an EVM-origin store. Needs only a read-only
 * `ethers` Provider: the live LayerZero fee comes from the adapter's `quote()` view
 * and the storage (escrow) part from the relayer, exactly as `priceQuote()` does.
 */

import { ADAPTER_ABI } from "./abi.js";
import { loadEthers, type EthersModuleLike, type EthersRunnerLike } from "./signer.js";
import type { MessagingFee } from "./client.js";
import { TESTNET, type BosphorNetwork } from "../networks.js";
import { fetchQuote, resolveStoreSize, type PricedQuote, type StoreSize } from "../quote.js";
import { DEFAULT_DEADLINE_SECONDS, DEFAULT_EPOCHS, type FetchLike } from "../store-flow.js";
import type { Hex } from "../types.js";

interface QuoteStoreCommon {
  /** Storage duration in Walrus epochs; defaults to 5. */
  epochs?: number;
  /** Network preset; defaults to {@link TESTNET}. */
  network?: BosphorNetwork;
  /** `fetch` implementation for the relayer call; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Cancel the relayer call. */
  signal?: AbortSignal;
}

export type QuoteEvmStoreOptions = StoreSize &
  QuoteStoreCommon & {
    /** A read-only `ethers` v6 Provider (a Signer works too) on the origin chain. */
    provider: EthersRunnerLike;
    /** Inject the `ethers` module (tests, or bundlers that cannot lazy-load). */
    ethers?: EthersModuleLike;
  };

interface QuoteView {
  quote(
    dstEid: number,
    blobId: Hex,
    size: number,
    encodingType: number,
    storageEpochs: number,
    deadline: bigint,
    options: Hex,
  ): Promise<MessagingFee>;
}

/**
 * Price an EVM-origin store without a wallet: the relayer's storage (escrow) price
 * plus the live LayerZero fee from the adapter's `quote()` view. Returns the same
 * {@link PricedQuote} as `client.priceQuote()`.
 *
 * @example
 * ```ts
 * import { JsonRpcProvider } from "ethers";
 * import { TESTNET, quoteEvmStore } from "@bosphor/sdk/evm";
 *
 * const quote = await quoteEvmStore({
 *   provider: new JsonRpcProvider(TESTNET.evm.rpcUrl),
 *   sizeBytes: 1024,
 * });
 * ```
 */
export async function quoteEvmStore(opts: QuoteEvmStoreOptions): Promise<PricedQuote> {
  const network = opts.network ?? TESTNET;
  const size = resolveStoreSize(opts);
  const epochs = opts.epochs ?? DEFAULT_EPOCHS;
  const { Contract } = await loadEthers(opts.ethers);
  const adapter = new Contract(
    network.evm.adapterAddress,
    ADAPTER_ABI,
    opts.provider as never,
  ) as unknown as QuoteView;

  // The LayerZero fee depends on the fixed-size message and the options, not on
  // the blob id or deadline values, so placeholders are exact here.
  const deadline = BigInt(Math.floor(Date.now() / 1000) + DEFAULT_DEADLINE_SECONDS);
  const fee = await adapter.quote(
    network.sui.eid,
    `0x${"00".repeat(32)}`,
    size,
    0,
    epochs,
    deadline,
    network.evm.lzOptions,
  );

  const fetchOpts: { fetch?: FetchLike; signal?: AbortSignal } = {};
  if (opts.fetch) fetchOpts.fetch = opts.fetch;
  if (opts.signal) fetchOpts.signal = opts.signal;
  return fetchQuote(
    network.relayerUrl,
    { sizeBytes: size, epochs, originToken: "ETH", forwardLzFeeNative: fee.nativeFee },
    fetchOpts,
  );
}
