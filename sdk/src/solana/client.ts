/**
 * Bosphor Solana client and the one-call `store()` orchestration.
 *
 * `store(data, { epochs })` runs the full happy path:
 *   encode -> submit -> upload -> awaitProof
 * and returns the verified `{ intentId, blobId, endEpoch }`, the SAME one-line API
 * as the EVM path. Every lower-level step stays public as an escape hatch.
 *
 * The client depends on `@solana/web3.js` (and, in the default backend, Anchor)
 * only through a minimal structural interface (`SolanaChain`), so those stay
 * optional peer dependencies: a Solana consumer passes a real backend, but the SDK
 * core never imports `@solana/web3.js` itself. Unit tests inject a fake `SolanaChain`
 * and never load the Solana stack, exactly like the EVM `@mysten/walrus` seam.
 *
 * Intent ids are the SAME canonical keccak digest as EVM/Sui/Solana (from the
 * shared `bosphor_commitment_codec`). The chain backend parses the id out of the
 * `IntentSubmitted` event logs of the submit transaction; the SDK does not assume a
 * nonce.
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
  type AwaitProofOptions,
  type EncodeOptions,
  type EncodedIntent,
  type FetchLike,
} from "../store-flow.js";

/** Commitment fields plus the chosen storage terms, ready to submit on Solana. */
export interface SolanaSubmitFields {
  /** 32-byte Walrus blob id as 0x hex. */
  blobId: Hex;
  /** Raw blob size in bytes (u32). */
  size: number;
  /** Walrus encoding type discriminant (u8). */
  encodingType: number;
  /** Committed Walrus storage duration in epochs (u32). */
  storageEpochs: number;
  /** Intent deadline as unix seconds (u64). */
  deadline: bigint;
  /** Destination LayerZero endpoint id (e.g. 40378 for Sui testnet). */
  dstEid: number;
  /** LayerZero messaging options bytes as 0x hex. */
  options: Hex;
  /** Native fee (lamports) attached for the LayerZero `send` CPI. */
  nativeFee: bigint;
  /** Lamports to escrow for this intent (0 for the unpriced path). */
  escrowAmount?: bigint;
}

/** The result of a submit: the canonical intent id and the Solana tx signature. */
export interface SolanaSubmitResult {
  /** Canonical keccak intent id, parsed from the `IntentSubmitted` event. */
  intentId: Hex;
  /** The Solana transaction signature of the submit. */
  signature: string;
}

/** The deserialized `IntentState` PDA fields the client reads to verify a proof. */
export interface SolanaIntentState {
  /** Whether the return proof has been recorded (`lz_receive` set it). */
  executed: boolean;
  /** The blob id committed at submission time, as 0x hex. */
  committedBlobId: Hex;
  /** Walrus end epoch recorded on execution (0n until executed). */
  endEpoch: bigint;
}

/**
 * Minimal structural surface of the Solana chain, mirroring the EVM
 * `AdapterContract`. A real backend builds + sends the `submit_intent` instruction
 * and reads the `IntentState` PDA; a test injects a fake. The SDK never imports
 * `@solana/web3.js` directly, only this shape.
 */
export interface SolanaChain {
  /**
   * Build and send the `submit_intent` instruction, returning the canonical
   * intent id parsed from the `IntentSubmitted` event logs of the confirmed
   * transaction (never assumed from a nonce) and the tx signature.
   */
  submitIntent(fields: SolanaSubmitFields): Promise<SolanaSubmitResult>;
  /**
   * Read and deserialize the per-intent `IntentState` PDA (`[b"intent", intentId]`)
   * for the given canonical intent id. Returns `null` if the account does not
   * exist yet.
   */
  readIntent(intentId: Hex): Promise<SolanaIntentState | null>;
}

export interface BosphorSolanaClientOptions {
  /** A `SolanaChain` backend bound to the deployed adapter and a funded wallet. */
  chain: SolanaChain;
  /** Base URL of the relayer's ingest endpoint, e.g. `https://relayer.bosphor.xyz`. */
  relayerUrl: string;
  /** LayerZero endpoint id of the destination chain (e.g. 40378 for Sui testnet). */
  dstEid: number;
  /** LayerZero messaging options as 0x hex; defaults to `0x`. */
  options?: Hex;
  /** Native fee (lamports) for the LayerZero `send` CPI; defaults to 0n. */
  nativeFee?: bigint;
  /** Default storage duration in epochs when `store`/`encode` is called without one. */
  defaultEpochs?: number;
  /** Seconds added to `now` to derive the deadline when not supplied. */
  deadlineSeconds?: number;
  /**
   * Walrus network for the default blob-id computation. Set to `"mainnet"` for a
   * mainnet deployment. Ignored when `computeBlob` is provided. Defaults to
   * `"testnet"`.
   */
  network?: WalrusNetwork;
  /** Blob-id computation seam; defaults to the `@mysten/walrus`-backed impl. */
  computeBlob?: ComputeBlob;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export interface SubmitOptions {
  /** Override the client's destination endpoint id. */
  dstEid?: number;
  /** Override the client's LayerZero options bytes. */
  options?: Hex;
  /** Override the client's native fee (lamports). */
  nativeFee?: bigint;
  /** Lamports to escrow for this intent (0 for the unpriced path). */
  escrowAmount?: bigint;
}

/**
 * High-level Bosphor client for the Solana origin path. Construct one per adapter
 * backend and destination, then call `store()` for the one-shot flow or the
 * individual steps (`encode`, `submit`, `upload`, `awaitProof`) as escape hatches.
 */
export class BosphorSolanaClient {
  private readonly chain: SolanaChain;
  private readonly relayerUrl: string;
  private readonly dstEid: number;
  private readonly options: Hex;
  private readonly nativeFee: bigint;
  private readonly defaultEpochs: number;
  private readonly deadlineSeconds: number;
  private readonly computeBlobFn: ComputeBlob;
  private readonly fetchFn: FetchLike;

  constructor(opts: BosphorSolanaClientOptions) {
    if (!opts.chain) throw new Error("BosphorSolanaClient requires a chain backend");
    if (!opts.relayerUrl) throw new Error("BosphorSolanaClient requires a relayerUrl");
    if (opts.dstEid === undefined) throw new Error("BosphorSolanaClient requires a dstEid");

    this.chain = opts.chain;
    this.relayerUrl = opts.relayerUrl.replace(/\/+$/, "");
    this.dstEid = opts.dstEid;
    this.options = opts.options ?? "0x";
    this.nativeFee = opts.nativeFee ?? 0n;
    this.defaultEpochs = opts.defaultEpochs ?? DEFAULT_EPOCHS;
    this.deadlineSeconds = opts.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS;
    this.computeBlobFn = opts.computeBlob ?? createDefaultComputeBlob(opts.network ?? "testnet");
    this.fetchFn = resolveFetch(opts.fetch);
  }

  /**
   * Encode raw bytes into the commitment fields: derive the blob id locally, pick
   * the storage duration, and compute the deadline. No chain interaction happens
   * here. Fails loudly if the blob id cannot be derived. Identical to the EVM path.
   */
  async encode(data: Uint8Array, opts: EncodeOptions = {}): Promise<EncodedIntent> {
    return encodeIntent(this.computeBlobFn, data, opts, {
      defaultEpochs: this.defaultEpochs,
      deadlineSeconds: this.deadlineSeconds,
    });
  }

  /**
   * Submit the intent on-chain via the backend's `submit_intent` instruction.
   * Returns the intent id parsed from the `IntentSubmitted` event logs. Fails
   * loudly if the backend yields no intent id.
   */
  async submit(
    encoded: EncodedIntent,
    opts: SubmitOptions = {},
  ): Promise<{ intentId: Hex; txHash: string }> {
    const result = await this.chain.submitIntent({
      blobId: encoded.blobId,
      size: encoded.size,
      encodingType: encoded.encodingType,
      storageEpochs: encoded.storageEpochs,
      deadline: encoded.deadline,
      dstEid: opts.dstEid ?? this.dstEid,
      options: opts.options ?? this.options,
      nativeFee: opts.nativeFee ?? this.nativeFee,
      escrowAmount: opts.escrowAmount ?? 0n,
    });

    if (!result.intentId) {
      throw new Error(
        "submit_intent produced no IntentSubmitted event; cannot determine intent id",
      );
    }
    return { intentId: result.intentId, txHash: result.signature };
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
    await uploadBlob(this.fetchFn, this.relayerUrl, intentId, data, opts.signal);
  }

  /**
   * Poll `readIntent(intentId)` until it reports `executed`, then return the
   * committed blob id and the recorded end epoch straight from the `IntentState`
   * PDA (the on-chain proof of record). Throws `ProofTimeoutError` if the intent
   * never executes within `timeoutMs`. Never fabricates a blob id or epoch.
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
      const state = await this.chain.readIntent(intentId);
      if (state && state.executed) {
        return { blobId: state.committedBlobId, endEpoch: state.endEpoch };
      }
      if (Date.now() >= deadline) {
        throw new ProofTimeoutError(intentId, timeoutMs);
      }
      await sleep(pollMs, opts.signal);
    }
  }

  /**
   * One-call flow: encode -> submit -> upload -> awaitProof. Returns the verified
   * `{ intentId, blobId, endEpoch }`. Every step fails loudly; no value is
   * fabricated on error. (Solana has no separate quote step: the LayerZero fee is
   * passed as `nativeFee` on the `submit_intent` instruction.)
   *
   * @param data - The raw bytes to store on Walrus.
   * @param opts - Storage terms (`epochs`, `deadline`), submit overrides
   *   (`dstEid`, `options`, `nativeFee`), proof-poll tuning (`timeoutMs`,
   *   `pollMs`), and an optional `signal` to cancel the flow.
   * @returns The verified `{ intentId, blobId, endEpoch }`.
   * @throws {@link RelayerUploadError} if the relayer rejects the blob upload.
   * @throws {@link ProofTimeoutError} if the intent does not execute in time.
   * @example
   * ```ts
   * const { intentId, blobId, endEpoch } = await client.store(fileBytes, { epochs: 5 });
   * ```
   */
  async store(
    data: Uint8Array,
    opts: EncodeOptions & SubmitOptions & AwaitProofOptions = {},
  ): Promise<StoreResult> {
    opts.signal?.throwIfAborted();
    const encoded = await this.encode(data, opts);
    const { intentId, txHash } = await this.submit(encoded, opts);
    await this.upload(intentId, data, { signal: opts.signal });
    const { blobId, endEpoch } = await this.awaitProof(intentId, opts);
    return { intentId, blobId, endEpoch, txHash };
  }

  /**
   * Fetch an all-in priced quote (SOL) from the relayer for this intent: the
   * forward LayerZero fee plus the relayer-fronted escrow bucket, as one
   * origin-native amount with a full USD breakdown.
   */
  async priceQuote(
    encoded: EncodedIntent,
    opts: { signal?: AbortSignal | undefined } = {},
  ): Promise<PricedQuote> {
    return fetchQuote(
      this.relayerUrl,
      {
        sizeBytes: encoded.size,
        epochs: encoded.storageEpochs,
        originToken: "SOL",
        forwardLzFeeNative: this.nativeFee,
      },
      { fetch: this.fetchFn, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
  }

  /**
   * Submit paying the priced quote: the escrow bucket is deposited into the
   * per-intent vault and released to the relayer only on the proof. The forward
   * LZ fee is still passed as the `submit_intent` nativeFee.
   */
  async submitPaid(
    encoded: EncodedIntent,
    quote: PricedQuote,
    opts: SubmitOptions = {},
  ): Promise<{ intentId: Hex; txHash: string }> {
    return this.submit(encoded, { ...opts, escrowAmount: quote.escrowNative });
  }

  /**
   * One-call PRICED flow (the M4 user-pays path):
   *   encode -> priceQuote -> submitPaid -> upload -> awaitProof
   * Returns the verified result plus the `quote` used so a caller can surface the
   * breakdown. Every step fails loudly.
   */
  async storePriced(
    data: Uint8Array,
    opts: EncodeOptions & SubmitOptions & AwaitProofOptions = {},
  ): Promise<StoreResult & { quote: PricedQuote }> {
    opts.signal?.throwIfAborted();
    const encoded = await this.encode(data, opts);
    const quote = await this.priceQuote(encoded, { signal: opts.signal });
    const { intentId, txHash } = await this.submitPaid(encoded, quote, opts);
    await this.upload(intentId, data, { signal: opts.signal });
    const { blobId, endEpoch } = await this.awaitProof(intentId, opts);
    return { intentId, blobId, endEpoch, txHash, quote };
  }
}

/** Factory mirror of `new BosphorSolanaClient(opts)`. */
export function createBosphorSolanaClient(
  opts: BosphorSolanaClientOptions,
): BosphorSolanaClient {
  return new BosphorSolanaClient(opts);
}
