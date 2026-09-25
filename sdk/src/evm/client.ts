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
import { createDefaultComputeBlob, type WalrusNetwork } from "../blob.js";
import { ProofTimeoutError } from "../errors.js";
import { fetchQuote, type PricedQuote } from "../quote.js";
import {
  DEFAULT_EPOCHS,
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  encodeIntent,
  resolveFetch,
  sleep,
  uploadBlob,
  validateAppId,
  type AwaitProofOptions,
  type EncodeOptions,
  type ProgressOptions,
  type EncodedIntent,
  type FetchLike,
  isTransientRpcError,
} from "../store-flow.js";

/** Minimal structural view of the fields we read off an ethers `TransactionReceipt`. */
export interface EvmLog {
  /** The indexed event topics. */
  topics: readonly string[];
  /** The ABI-encoded non-indexed event data. */
  data: string;
}

/** Minimal structural view of an ethers `TransactionReceipt`: only its logs are read. */
export interface EvmTransactionReceipt {
  /** The logs the transaction emitted. */
  logs: readonly EvmLog[];
}

/** Minimal structural view of an ethers `ContractTransactionResponse`. */
export interface EvmContractTransaction {
  /** The transaction hash. */
  hash: string;
  /** Resolves with the receipt once the transaction is mined. */
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
  ): Promise<MessagingFee>;
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
  /** Optional (escrow adapter): the escrow record for an intent. */
  getEscrow?(intentId: Hex): Promise<RawEscrowRecord>;
  /** Optional (escrow adapter): refund a pending escrow to its payer after the deadline. */
  refund?(intentId: Hex): Promise<EvmContractTransaction>;
  /** Optional (escrow adapter): withdraw the caller's released or refunded balance. */
  withdraw?(): Promise<EvmContractTransaction>;
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

/** The escrow record as the adapter's `getEscrow` returns it (ethers `Result` fields). */
export interface RawEscrowRecord {
  /** The address that paid. */
  payer: string;
  /** The escrowed token, the zero address for native ETH. */
  token: string;
  /** Escrowed amount in the token's smallest unit. */
  amount: bigint;
  /** Unix seconds after which `refund` is allowed. */
  deadline: bigint;
  /** An `EscrowStatus` value, as a `bigint` or `number` depending on the ABI decoder. */
  status: bigint | number;
}

/** An intent's escrow, normalized. `status` is an `EscrowStatus` value (0 to 3). */
export interface EscrowRecord {
  /** The address that paid, and that a refund goes to. */
  payer: string;
  /** `0x0000...0000` for native ETH. */
  token: string;
  /** Escrowed amount in wei. */
  amount: bigint;
  /** Unix seconds after which `refund` is allowed. */
  deadline: bigint;
  /** 0 None, 1 Pending, 2 Released, 3 Refunded. */
  status: number;
}

/** The LayerZero messaging fee, as returned by `quote`. */
export interface MessagingFee {
  /** The fee in the chain's native token (wei). */
  nativeFee: bigint;
  /** The fee in the LayerZero token. Bosphor does not use it, so it is `0n`. */
  lzTokenFee: bigint;
}

/**
 * Options for `new BosphorEvmClient(opts)` and {@link createBosphorClient}. Most
 * integrators use `createBosphorClientFromSigner`, which fills these from a
 * network preset.
 */
export interface BosphorEvmClientOptions {
  /** An `ethers.Contract` bound to the deployed BosphorAdapter, with a signer. */
  adapter: AdapterContract;
  /** Base URL of the relayer's ingest endpoint, e.g. `https://api.bosphor.xyz/testnet` (`TESTNET.relayerUrl`). */
  relayerUrl: string;
  /** LayerZero endpoint id of the destination chain (e.g. 40378 for Sui testnet). */
  dstEid: number;
  /** LayerZero messaging options; defaults to `0x`. */
  options?: Hex;
  /** Default storage duration in epochs when `store`/`encode` is called without one. */
  defaultEpochs?: number;
  /** Seconds added to `now` to derive the deadline when not supplied. */
  deadlineSeconds?: number;
  /**
   * Walrus network for the default blob-id computation. The blob id differs
   * between testnet and mainnet, so set this to `"mainnet"` for a mainnet adapter.
   * Ignored when `computeBlob` is provided. Defaults to `"testnet"`.
   */
  network?: WalrusNetwork;
  /** Blob-id computation seam; defaults to the `@mysten/walrus`-backed impl. */
  computeBlob?: ComputeBlob;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
  /**
   * Optional integrator application id (a short slug such as `"my-dapp"`). Sent
   * as the `X-Bosphor-App` header on quote and upload requests so the relayer
   * can attribute usage to your app. Attribution only, not authentication.
   * Validated at construction: letters, digits, `-`, `_`, `.`, max 64 chars.
   */
  appId?: string;
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
  private readonly appId: string | undefined;

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
    this.computeBlobFn = opts.computeBlob ?? createDefaultComputeBlob(opts.network ?? "testnet");
    this.fetchFn = resolveFetch(opts.fetch);
    this.appId = validateAppId(opts.appId);
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
   * Fetch an all-in priced quote from the relayer for this intent: the forward
   * LayerZero fee (read from the adapter) plus the relayer-fronted escrow bucket,
   * as one origin-native amount with a full USD breakdown. This is the number the
   * user pays; the escrow adapter keeps only the LZ fee and escrows the rest.
   */
  async priceQuote(
    encoded: EncodedIntent,
    opts: { signal?: AbortSignal | undefined } = {},
  ): Promise<PricedQuote> {
    const fee = await this.quote(encoded);
    return fetchQuote(
      this.relayerUrl,
      {
        sizeBytes: encoded.size,
        epochs: encoded.storageEpochs,
        originToken: "ETH",
        // The forward LZ fee is user-direct (spent by _lzSend). Origin gas is the
        // tx gas the wallet pays separately, NOT msg.value, so it is not included.
        forwardLzFeeNative: fee.nativeFee,
      },
      {
        fetch: this.fetchFn,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(this.appId ? { appId: this.appId } : {}),
      },
    );
  }

  /**
   * Submit the intent on-chain paying the all-in priced quote: `msg.value` is the
   * escrow bucket plus the forward LZ fee. The escrow adapter forwards only the
   * LZ fee to the endpoint and escrows the surplus, keyed by intent id.
   */
  async submitPaid(
    encoded: EncodedIntent,
    quote: PricedQuote,
  ): Promise<{ intentId: Hex; txHash: string }> {
    return this.submitWithValue(encoded, quote.escrowNative + quote.forwardNative);
  }

  /**
   * Submit the intent on-chain, attaching `fee.nativeFee` as native value. Returns
   * the intent id read from the `IntentSubmitted` event and the origin transaction
   * hash. Fails loudly if the receipt yields no intent id.
   */
  async submit(encoded: EncodedIntent, fee: MessagingFee): Promise<{ intentId: Hex; txHash: string }> {
    return this.submitWithValue(encoded, fee.nativeFee);
  }

  /** Shared submit path: attach `value` as native and extract the intent id. */
  private async submitWithValue(
    encoded: EncodedIntent,
    value: bigint,
  ): Promise<{ intentId: Hex; txHash: string }> {
    const tx = await this.adapter.submitIntent(
      this.dstEid,
      encoded.blobId,
      encoded.size,
      encoded.encodingType,
      encoded.storageEpochs,
      encoded.deadline,
      this.options,
      { value },
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
    return { intentId, txHash: tx.hash };
  }

  /**
   * Upload the raw blob bytes out-of-band to the relayer:
   * `POST {relayerUrl}/blob/{intentId}` with the bytes as the raw body. Throws a
   * `RelayerUploadError` carrying the relayer's reason on any non-2xx.
   */
  async upload(
    intentId: Hex,
    data: Uint8Array,
    opts: { signal?: AbortSignal | undefined } = {},
  ): Promise<void> {
    await uploadBlob(this.fetchFn, this.relayerUrl, intentId, data, opts.signal, this.appId);
  }

  /**
   * Poll `executed(intentId)` until it is true, then return the committed blob id
   * (from `committedBlobId`, which equals the proof blob id, enforced on-chain) and
   * the proof's end epoch. The end epoch is decoded from the `IntentExecuted` proof
   * via the adapter's `queryProof`; if the adapter does not provide `queryProof`
   * this throws rather than fabricate an epoch. An adapter built with
   * {@link fromEthersContract} wires `queryProof` automatically. Throws
   * `ProofTimeoutError` if the intent never executes within `timeoutMs`.
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
      let done = false;
      try {
        done = await this.adapter.executed(intentId);
      } catch (err) {
        // A public RPC dropping one poll must not fail a minutes-long wait; keep
        // polling until the deadline. Anything else is a real failure.
        if (!isTransientRpcError(err)) throw err;
      }
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
    opts: EncodeOptions & AwaitProofOptions & ProgressOptions = {},
  ): Promise<StoreResult> {
    const emit = opts.onProgress ?? (() => {});
    opts.signal?.throwIfAborted();
    const encoded = await this.encode(data, opts);
    emit({ step: "encoded", encoded });
    const fee = await this.quote(encoded);
    emit({ step: "quoted", amount: fee.nativeFee });
    const { intentId, txHash } = await this.submit(encoded, fee);
    emit({ step: "submitted", intentId, txHash });
    await this.upload(intentId, data, { signal: opts.signal });
    emit({ step: "uploaded", intentId });
    const { blobId, endEpoch } = await this.awaitProof(intentId, opts);
    emit({ step: "proven", intentId, blobId, endEpoch });
    return { intentId, blobId, endEpoch, txHash };
  }

  /**
   * One-call PRICED flow (the M4 user-pays path):
   *   encode -> priceQuote -> submitPaid -> upload -> awaitProof
   * The user pays the single all-in quote at submit; the escrow releases to the
   * relayer only on the proof. Returns the verified result plus the `quote` used,
   * so a caller can surface the breakdown. Every step fails loudly.
   */
  async storePriced(
    data: Uint8Array,
    opts: EncodeOptions & AwaitProofOptions & ProgressOptions = {},
  ): Promise<StoreResult & { quote: PricedQuote }> {
    const emit = opts.onProgress ?? (() => {});
    opts.signal?.throwIfAborted();
    const encoded = await this.encode(data, opts);
    emit({ step: "encoded", encoded });
    const quote = await this.priceQuote(encoded, { signal: opts.signal });
    emit({ step: "quoted", amount: quote.escrowNative + quote.forwardNative, quote });
    const { intentId, txHash } = await this.submitPaid(encoded, quote);
    emit({ step: "submitted", intentId, txHash });
    await this.upload(intentId, data, { signal: opts.signal });
    emit({ step: "uploaded", intentId });
    const { blobId, endEpoch } = await this.awaitProof(intentId, opts);
    emit({ step: "proven", intentId, blobId, endEpoch });
    return { intentId, blobId, endEpoch, txHash, quote };
  }

  /**
   * Read the escrow record of an intent (escrow adapter only). `status` is an
   * `EscrowStatus` value: 0 None, 1 Pending, 2 Released, 3 Refunded.
   */
  async getEscrow(intentId: Hex): Promise<EscrowRecord> {
    const raw = await this.requireMember("getEscrow").call(this.adapter, intentId);
    return {
      payer: raw.payer,
      token: raw.token,
      amount: raw.amount,
      deadline: raw.deadline,
      status: Number(raw.status),
    };
  }

  /**
   * Refund an intent's pending escrow to its payer once the deadline has passed.
   * Anyone may call it; the funds are credited to the recorded payer, who then
   * collects them with {@link withdraw}. Reverts `DeadlineNotReached` before the
   * deadline and `EscrowNotPending` if already released or refunded.
   */
  async refund(intentId: Hex): Promise<{ txHash: string }> {
    const tx = await this.requireMember("refund").call(this.adapter, intentId);
    await tx.wait();
    return { txHash: tx.hash };
  }

  /**
   * Withdraw the signer's credited balance (refunds for a payer, releases for the
   * relayer). The adapter uses pull payments, so a refund is not sent until this
   * is called. Reverts `NothingToWithdraw` when the balance is zero.
   */
  async withdraw(): Promise<{ txHash: string }> {
    const tx = await this.requireMember("withdraw").call(this.adapter);
    await tx.wait();
    return { txHash: tx.hash };
  }

  private requireMember<K extends "getEscrow" | "refund" | "withdraw">(
    name: K,
  ): NonNullable<AdapterContract[K]> {
    const fn = this.adapter[name];
    if (!fn) {
      throw new Error(
        `the adapter does not expose ${name}(); bind it with ADAPTER_ABI (connectAdapter or ` +
          `createBosphorClientFromSigner) against the escrow adapter`,
      );
    }
    return fn as NonNullable<AdapterContract[K]>;
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
