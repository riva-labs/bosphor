/**
 * Build a ready-to-use EVM client from an `ethers` Signer, with no ABI or address
 * wiring on the caller's side. The adapter address, LayerZero options, relayer URL,
 * destination endpoint id, and Walrus network all come from a network preset
 * (default {@link TESTNET}); any of them can be overridden.
 *
 * `ethers` stays an optional peer dependency: it is loaded through a lazy dynamic
 * import only when these helpers run. Tests inject a stub module instead.
 */

import { ADAPTER_ABI } from "./abi.js";
import { fromEthersContract, type EthersContractLike, type FromEthersContractOptions } from "./adapter.js";
import { BosphorEvmClient, type AdapterContract, type BosphorEvmClientOptions } from "./client.js";
import { TESTNET, type BosphorNetwork } from "../networks.js";

/**
 * An `ethers` v6 contract runner: a Provider (read-only) or a Signer. Both carry a
 * `provider` field, which is all these helpers rely on structurally.
 */
export interface EthersRunnerLike {
  readonly provider: object | null;
}

/** An `ethers` v6 Signer (e.g. `Wallet`, or `BrowserProvider#getSigner()`). */
export interface EthersSignerLike extends EthersRunnerLike {
  getAddress(): Promise<string>;
}

/**
 * The slice of the `ethers` module these helpers use. The runner parameter is
 * typed `never` so the real `ethers` module (whose `ContractRunner` type is richer
 * than {@link EthersRunnerLike}) can be injected without a cast.
 */
export interface EthersModuleLike {
  Contract: new (address: string, abi: readonly string[], runner?: never) => object;
}

/** Options for {@link connectAdapter}. */
export interface ConnectAdapterOptions extends FromEthersContractOptions {
  /** Network preset; defaults to {@link TESTNET}. */
  network?: BosphorNetwork;
  /** Adapter address override; defaults to `network.evm.adapterAddress`. */
  address?: string;
  /** Inject the `ethers` module (tests, or bundlers that cannot lazy-load). */
  ethers?: EthersModuleLike;
}

/**
 * Options for {@link createBosphorClientFromSigner}: the adapter binding plus any
 * client option to override the network preset's value.
 */
export interface CreateClientFromSignerOptions
  extends ConnectAdapterOptions,
    Partial<Omit<BosphorEvmClientOptions, "adapter" | "network">> {}

export async function loadEthers(injected?: EthersModuleLike): Promise<EthersModuleLike> {
  if (injected) return injected;
  const spec = "ethers";
  try {
    return (await import(spec)) as EthersModuleLike;
  } catch (err) {
    throw new Error(
      "this helper requires the optional peer dependency 'ethers' (v6). Install it " +
        `(npm install ethers) or build the adapter with fromEthersContract. Underlying error: ${String(err)}`,
    );
  }
}

/**
 * Bind the Bosphor adapter to an `ethers` Signer and return it as an
 * {@link AdapterContract} (with `queryProof` wired, so the proof's end epoch is
 * read automatically). Uses the SDK's bundled {@link ADAPTER_ABI}.
 *
 * @param signer - An `ethers` v6 Signer connected to the adapter's chain.
 */
export async function connectAdapter(
  signer: EthersSignerLike,
  opts: ConnectAdapterOptions = {},
): Promise<AdapterContract> {
  if (!signer) throw new Error("connectAdapter requires an ethers Signer");
  const network = opts.network ?? TESTNET;
  const address = opts.address ?? network.evm.adapterAddress;
  const { Contract } = await loadEthers(opts.ethers);
  const contract = new Contract(address, ADAPTER_ABI, signer as never) as unknown as EthersContractLike;
  const adapterOpts: FromEthersContractOptions = {};
  if (opts.proofLookbackBlocks !== undefined) adapterOpts.proofLookbackBlocks = opts.proofLookbackBlocks;
  return fromEthersContract(contract, adapterOpts);
}

/**
 * Create a {@link BosphorEvmClient} from an `ethers` Signer in one call. Every
 * deployment detail comes from the network preset (default {@link TESTNET}).
 *
 * @example
 * ```ts
 * import { JsonRpcProvider, Wallet } from "ethers";
 * import { createBosphorClientFromSigner } from "@bosphor/sdk/evm";
 *
 * const signer = new Wallet(process.env.PRIVATE_KEY!, new JsonRpcProvider(RPC_URL));
 * const client = await createBosphorClientFromSigner(signer);
 * const { intentId, blobId } = await client.storePriced(bytes);
 * ```
 */
export async function createBosphorClientFromSigner(
  signer: EthersSignerLike,
  opts: CreateClientFromSignerOptions = {},
): Promise<BosphorEvmClient> {
  const network = opts.network ?? TESTNET;
  const adapter = await connectAdapter(signer, opts);

  const clientOpts: BosphorEvmClientOptions = {
    adapter,
    relayerUrl: opts.relayerUrl ?? network.relayerUrl,
    dstEid: opts.dstEid ?? network.sui.eid,
    options: opts.options ?? network.evm.lzOptions,
    network: network.walrusNetwork,
  };
  if (opts.defaultEpochs !== undefined) clientOpts.defaultEpochs = opts.defaultEpochs;
  if (opts.deadlineSeconds !== undefined) clientOpts.deadlineSeconds = opts.deadlineSeconds;
  if (opts.computeBlob !== undefined) clientOpts.computeBlob = opts.computeBlob;
  if (opts.fetch !== undefined) clientOpts.fetch = opts.fetch;
  if (opts.appId !== undefined) clientOpts.appId = opts.appId;

  return new BosphorEvmClient(clientOpts);
}
