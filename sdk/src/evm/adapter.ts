/**
 * Build a {@link AdapterContract} from an `ethers.Contract` bound to BosphorAdapter.
 *
 * Consumers were hand-assembling the ~10-member `AdapterContract` and casting the
 * contract with `as unknown as AdapterContract`, and had to write `queryProof`
 * from the `IntentExecuted` event log themselves just to get `endEpoch`. This
 * factory does both: it delegates every method to the contract and wires
 * `queryProof` automatically, so `awaitProof`/`store` resolve the end epoch with
 * no extra work. `ethers` is never imported here; the contract is accepted through
 * a minimal structural interface, so `ethers` stays an optional peer dependency.
 */

import type { AdapterContract, EvmContractTransaction, MessagingFee } from "./client.js";
import type { Hex } from "../types.js";

/** The minimal structural surface of an `ethers.Contract` bound to BosphorAdapter. */
export interface EthersContractLike {
  submitIntent(
    dstEid: number,
    blobId: Hex,
    size: number,
    encodingType: number,
    storageEpochs: number,
    deadline: bigint,
    options: Hex,
    overrides: { value: bigint },
  ): Promise<EvmContractTransaction>;
  quote(
    dstEid: number,
    blobId: Hex,
    size: number,
    encodingType: number,
    storageEpochs: number,
    deadline: bigint,
    options: Hex,
  ): Promise<MessagingFee>;
  executed(intentId: Hex): Promise<boolean>;
  committedBlobId(intentId: Hex): Promise<Hex>;
  getIntentId?(
    sender: string,
    blobId: Hex,
    size: number,
    encodingType: number,
    storageEpochs: number,
    deadline: bigint,
    nonce: bigint,
  ): Promise<Hex>;
  nonces?(sender: string): Promise<bigint>;
  interface: AdapterContract["interface"];
  filters: { IntentExecuted(intentId: Hex): unknown };
  queryFilter(
    event: unknown,
    fromBlock?: number | string,
  ): Promise<ReadonlyArray<{ args?: { proof?: string } | undefined } | undefined>>;
  getAddress?(): Promise<string>;
}

export interface FromEthersContractOptions {
  /**
   * How many blocks back `queryProof` scans for the `IntentExecuted` event when
   * reading the end epoch. Defaults to 50_000.
   */
  proofLookbackBlocks?: number;
}

/**
 * Adapt an `ethers.Contract` (bound to a deployed BosphorAdapter, with a signer)
 * into the SDK's {@link AdapterContract}, including a `queryProof` implementation
 * that reads the `IntentExecuted` proof from the event log.
 *
 * @example
 * ```ts
 * import { Contract } from "ethers";
 * import { createBosphorClient, fromEthersContract } from "@bosphor/sdk/evm";
 *
 * const contract = new Contract(adapterAddress, ADAPTER_ABI, signer);
 * const client = createBosphorClient({
 *   adapter: fromEthersContract(contract),
 *   relayerUrl: "https://api.bosphor.xyz/testnet",
 *   dstEid: 40378,
 * });
 * ```
 */
export function fromEthersContract(
  contract: EthersContractLike,
  opts: FromEthersContractOptions = {},
): AdapterContract {
  const lookback = opts.proofLookbackBlocks ?? 50_000;

  const adapter: AdapterContract = {
    submitIntent: (dstEid, blobId, size, encodingType, storageEpochs, deadline, options, overrides) =>
      contract.submitIntent(dstEid, blobId, size, encodingType, storageEpochs, deadline, options, overrides),
    quote: (dstEid, blobId, size, encodingType, storageEpochs, deadline, options) =>
      contract.quote(dstEid, blobId, size, encodingType, storageEpochs, deadline, options),
    executed: (intentId) => contract.executed(intentId),
    committedBlobId: (intentId) => contract.committedBlobId(intentId),
    // Read the IntentExecuted proof (abi.encode(blobId, endEpoch)) from the log so
    // the client can decode the exact end epoch. Returns null if none is found yet.
    queryProof: async (intentId) => {
      const filter = contract.filters.IntentExecuted(intentId);
      const events = await contract.queryFilter(filter, -lookback);
      const last = events[events.length - 1];
      const proof = last?.args?.proof;
      return (proof as Hex | undefined) ?? null;
    },
    interface: contract.interface,
  };

  // Optional members: only forward what the contract actually exposes.
  if (contract.getIntentId) {
    adapter.getIntentId = (sender, blobId, size, encodingType, storageEpochs, deadline, nonce) =>
      contract.getIntentId!(sender, blobId, size, encodingType, storageEpochs, deadline, nonce);
  }
  if (contract.nonces) {
    adapter.nonces = (sender) => contract.nonces!(sender);
  }
  if (contract.getAddress) {
    adapter.getAddress = () => contract.getAddress!();
  }

  return adapter;
}
