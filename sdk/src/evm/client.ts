/**
 * Bosphor EVM client and the one-call `store()` orchestration.
 *
 * `store(data, { epochs })` runs the full happy path:
 *   encode -> quote -> submit -> upload -> awaitProof
 * and returns the verified `{ intentId, blobId, endEpoch }`. Every lower-level step
 * stays public as an escape hatch for callers that need finer control.
 *
 * The client depends on `ethers` only through a minimal structural interface, so
 * `ethers` stays an optional peer dependency: an EVM consumer passes an
 * `ethers.Contract`, but the SDK core never imports `ethers` itself.
 */

import type { ComputeBlob, Hex, StoreResult } from "../types.js";
import { defaultComputeBlob } from "../blob.js";
import { ProofTimeoutError } from "../errors.js";
import {
  DEFAULT_EPOCHS,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  encodeIntent,
  resolveFetch,
  sleep,
  uploadBlob,
  type AwaitProofOptions,
  type EncodeOptions,
  type EncodedIntent,
  type FetchLike,
} from "../store-flow.js";

/** Minimal structural view of the fields we read off an ethers `TransactionReceipt`. */
export interface EvmLog {
  topics: readonly string[];
  data: string;
}

export interface EvmTransactionReceipt {
  logs: readonly EvmLog[];
}

export interface EvmContractTransaction {
  hash: string;
  wait(): Promise<EvmTransactionReceipt | null>;
}

/** The minimal structural surface of the `ethers.Contract` bound to BosphorAdapter. */
export interface AdapterContract {
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
  ): Promise<{ nativeFee: bigint; lzTokenFee: bigint }>;
  executed(intentId: Hex): Promise<boolean>;
  committedBlobId(intentId: Hex): Promise<Hex>;
  /**
   * Optional: return the raw `IntentExecuted` proof bytes (`abi.encode(blobId,
   * endEpoch)`) for an executed intent, or null if none. When present, the client
   * decodes the exact `endEpoch` from it; when absent the client reports `0n`.
   * An ethers-based consumer implements this by querying the `IntentExecuted`
   * event log for the intent id.
   */
  queryProof?(intentId: Hex): Promise<Hex | null>;
  getIntentId(
    sender: string,
    blobId: Hex,
    size: number,
    encodingType: number,
    storageEpochs: number,
    deadline: bigint,
    nonce: bigint,
  ): Promise<Hex>;
  nonces(sender: string): Promise<bigint>;
  interface: {
    parseLog(log: { topics: readonly string[]; data: string }): {
      name: string;
      args: Record<string, unknown> & ArrayLike<unknown>;
    } | null;
    decodeEventLog?(name: string, data: string, topics: readonly string[]): unknown;
  };
  /** Address of the signer bound to the contract, used to derive the intent id locally. */
  getAddress?(): Promise<string>;
  runner?: { getAddress?(): Promise<string> } | null;
}

/** The LayerZero messaging fee, as returned by `quote`. */
export interface MessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

export interface BosphorEvmClientOptions {
  /** An `ethers.Contract` bound to the deployed BosphorAdapter, with a signer. */
  adapter: AdapterContract;
  /** Base URL of the relayer's ingest endpoint, e.g. `https://relayer.bosphor.xyz`. */
  relayerUrl: string;
  /** LayerZero endpoint id of the destination chain (e.g. 40378 for Sui testnet). */
  dstEid: number;
  /** LayerZero messaging options; defaults to `0x`. */
  options?: Hex;
  /** Default storage duration in epochs when `store`/`encode` is called without one. */
  defaultEpochs?: number;
  /** Seconds added to `now` to derive the deadline when not supplied. */
  deadlineSeconds?: number;
  /** Blob-id computation seam; defaults to the `@mysten/walrus`-backed impl. */
  computeBlob?: ComputeBlob;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

/**
 * Decode the `endEpoch` from a Bosphor execution proof. The proof is
 * `abi.encode(bytes32 blobId, uint256 endEpoch)`, i.e. 64 hex-bytes: the blob id in
 * the first word and the end epoch in the second. Decoded here without pulling in
 * `ethers`, so the core stays dependency-light.
 */
export function decodeProofEndEpoch(proof: Hex): bigint {
  const hex = proof.startsWith("0x") ? proof.slice(2) : proof;
  if (hex.length !== 128) {
    throw new Error(`proof must be 64 bytes (abi.encode(bytes32,uint256)), got ${hex.length / 2}`);
  }
  return BigInt(`0x${hex.slice(64)}`);
}

/**
 * High-level Bosphor client for the EVM origin path. Construct one per adapter and
 * destination, then call `store()` for the one-shot flow or the individual steps
 * (`encode`, `quote`, `submit`, `upload`, `awaitProof`) as escape hatches.
 */
export class BosphorEvmClient {
  private readonly adapter: AdapterContract;
  private readonly relayerUrl: string;
  private readonly dstEid: number;
  private readonly options: Hex;
  private readonly defaultEpochs: number;
  private readonly deadlineSeconds: number;
  private readonly computeBlobFn: ComputeBlob;
  private readonly fetchFn: FetchLike;

  constructor(opts: BosphorEvmClientOptions) {
    if (!opts.adapter) throw new Error("BosphorEvmClient requires an adapter contract");
    if (!opts.relayerUrl) throw new Error("BosphorEvmClient requires a relayerUrl");
    if (opts.dstEid === undefined) throw new Error("BosphorEvmClient requires a dstEid");

    this.adapter = opts.adapter;
    this.relayerUrl = opts.relayerUrl.replace(/\/+$/, "");
    this.dstEid = opts.dstEid;
    this.options = opts.options ?? "0x";
    this.defaultEpochs = opts.defaultEpochs ?? DEFAULT_EPOCHS;
    this.deadlineSeconds = opts.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
    this.computeBlobFn = opts.computeBlob ?? defaultComputeBlob;
    this.fetchFn = resolveFetch(opts.fetch);
  }

  /**
   * Encode raw bytes into the commitment fields: derive the blob id locally, pick
   * the storage duration, and compute the deadline. No chain interaction happens
   * here. Fails loudly if the blob id cannot be derived.
   */
  async encode(data: Uint8Array, opts: EncodeOptions = {}): Promise<EncodedIntent> {
    return encodeIntent(this.computeBlobFn, data, opts, {
      defaultEpochs: this.defaultEpochs,
      deadlineSeconds: this.deadlineSeconds,
    });
  }

  /** Estimate the LayerZero messaging fee for submitting the given encoded intent. */
  async quote(encoded: EncodedIntent): Promise<MessagingFee> {
    const fee = await this.adapter.quote(
      this.dstEid,
      encoded.blobId,
      encoded.size,
      encoded.encodingType,
      encoded.storageEpochs,
      encoded.deadline,
      this.options,
    );
    return { nativeFee: fee.nativeFee, lzTokenFee: fee.lzTokenFee };
  }

  /**
   * Submit the intent on-chain, attaching `fee.nativeFee` as native value. Returns
   * the intent id read from the `IntentSubmitted` event (or derived locally as a
   * fallback). Fails loudly if the receipt yields no intent id.
   */
  async submit(encoded: EncodedIntent, fee: MessagingFee): Promise<{ intentId: Hex }> {
    const tx = await this.adapter.submitIntent(
      this.dstEid,
      encoded.blobId,
      encoded.size,
      encoded.encodingType,
      encoded.storageEpochs,
      encoded.deadline,
      this.options,
      { value: fee.nativeFee },
    );

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error(`submitIntent tx ${tx.hash} produced no receipt`);
    }

    const intentId = this.extractIntentId(receipt);
    if (!intentId) {
      throw new Error(
        `submitIntent tx ${tx.hash} emitted no IntentSubmitted event; cannot determine intent id`,
      );
    }
    return { intentId };
  }

  /**
   * Upload the raw blob bytes out-of-band to the relayer:
   * `POST {relayerUrl}/blob/{intentId}` with the bytes as the raw body. Throws a
   * `RelayerUploadError` carrying the relayer's reason on any non-2xx.
   */
  async upload(
    intentId: Hex,
    data: Uint8Array,
    opts: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await uploadBlob(this.fetchFn, this.relayerUrl, intentId, data, opts.signal);
  }

  /**
   * Poll `executed(intentId)` until it is true, then read and decode the committed
   * blob id and the proof's end epoch. Throws `ProofTimeoutError` if the intent
   * never executes within `timeoutMs`.
   *
   * Note: the adapter proof `abi.encode(blobId, endEpoch)` is emitted in the
   * `IntentExecuted` event, not stored. We surface the committed blob id from
   * `committedBlobId` (which equals the proof blob id, enforced on-chain) and the
   * end epoch from the same proof via the event when available. When the event is
   * not accessible through the polling view, `endEpoch` is read from the proof the
   * caller supplies; here we resolve it from `committedBlobId` and the stored
   * commitment, falling back to reading the emitted proof.
   */
  async awaitProof(
    intentId: Hex,
    opts: AwaitProofOptions = {},
  ): Promise<{ blobId: Hex; endEpoch: bigint }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      opts.signal?.throwIfAborted();
      const done = await this.adapter.executed(intentId);
      if (done) {
        const blobId = await this.adapter.committedBlobId(intentId);
        const endEpoch = await this.readEndEpoch(intentId);
        return { blobId, endEpoch };
      }
      if (Date.now() >= deadline) {
        throw new ProofTimeoutError(intentId, timeoutMs);
      }
      await sleep(pollMs, opts.signal);
    }
  }

  /**
   * One-call flow: encode -> quote -> submit -> upload -> awaitProof. Returns the
   * verified `{ intentId, blobId, endEpoch }`. Every step fails loudly; no value is
   * fabricated on error.
   *
   * @param data - The raw bytes to store on Walrus.
   * @param opts - Storage terms (`epochs`, `deadline`), proof-poll tuning
   *   (`timeoutMs`, `pollMs`), and an optional `signal` to cancel the flow.
   * @returns The verified `{ intentId, blobId, endEpoch }`.
   * @throws {@link RelayerUploadError} if the relayer rejects the blob upload.
   * @throws {@link ProofTimeoutError} if the intent does not execute in time.
   * @example
   * ```ts
   * const ac = new AbortController();
   * const { intentId, blobId, endEpoch } = await client.store(fileBytes, {
   *   epochs: 5,
   *   signal: ac.signal,
   * });
   * ```
   */
  async store(
    data: Uint8Array,
    opts: EncodeOptions & AwaitProofOptions = {},
  ): Promise<StoreResult> {
    opts.signal?.throwIfAborted();
    const encoded = await this.encode(data, opts);
    const fee = await this.quote(encoded);
    const { intentId } = await this.submit(encoded, fee);
    await this.upload(intentId, data, { signal: opts.signal });
    const { blobId, endEpoch } = await this.awaitProof(intentId, opts);
    return { intentId, blobId, endEpoch };
  }

  /**
   * Read the proof's end epoch by decoding the `IntentExecuted` proof bytes
   * (`abi.encode(blobId, endEpoch)`) when the adapter exposes `queryProof`. Returns
   * `0n` when no proof source is available, never a fabricated value.
   */
  private async readEndEpoch(intentId: Hex): Promise<bigint> {
    // Fail loudly rather than return a fabricated epoch: a silent 0n would look
    // like a real "expires at epoch 0" to callers reading the proof.
    if (!this.adapter.queryProof) {
      throw new Error(
        `Cannot read the proof endEpoch for ${intentId}: no queryProof source is configured. ` +
          `Provide a queryProof that reads the IntentExecuted proof so the SDK never returns a fabricated epoch.`,
      );
    }
    const proof = await this.adapter.queryProof(intentId);
    if (!proof) {
      throw new Error(
        `Intent ${intentId} is executed but no proof was found via queryProof; ` +
          `refusing to return a fabricated endEpoch.`,
      );
    }
    return decodeProofEndEpoch(proof);
  }

  /** Pull the intent id out of an `IntentSubmitted` log in the receipt. */
  private extractIntentId(receipt: EvmTransactionReceipt): Hex | undefined {
    for (const log of receipt.logs) {
      let parsed: { name: string; args: ArrayLike<unknown> & Record<string, unknown> } | null;
      try {
        parsed = this.adapter.interface.parseLog({ topics: log.topics, data: log.data });
      } catch {
        parsed = null;
      }
      if (parsed && parsed.name === "IntentSubmitted") {
        const id = (parsed.args as Record<string, unknown>).intentId ?? parsed.args[0];
        if (typeof id === "string") return id as Hex;
      }
    }
    return undefined;
  }
}

/** Factory mirror of `new BosphorEvmClient(opts)`. */
export function createBosphorClient(opts: BosphorEvmClientOptions): BosphorEvmClient {
  return new BosphorEvmClient(opts);
}
