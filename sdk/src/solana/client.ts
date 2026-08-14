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

import type { BlobEncoding, ComputeBlob, Hex, StoreResult } from "../types.ts";
import { defaultComputeBlob } from "../blob.ts";
import { ProofTimeoutError, RelayerUploadError } from "../evm/client.ts";

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

/** A `fetch`-shaped function, injectable so tests never hit the network. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    body: Uint8Array;
    headers: Record<string, string>;
  },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Fields derived from the raw bytes plus the chosen storage terms. */
export interface EncodedIntent extends BlobEncoding {
  /** Committed storage duration in Walrus epochs. */
  storageEpochs: number;
  /** Intent deadline as unix seconds (u64). */
  deadline: bigint;
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
  /** Blob-id computation seam; defaults to the `@mysten/walrus`-backed impl. */
  computeBlob?: ComputeBlob;
  /** `fetch` implementation; defaults to the global `fetch`. */
  fetch?: FetchLike;
}

export interface EncodeOptions {
  /** Storage duration in Walrus epochs. Defaults to the client default (5). */
  epochs?: number;
  /** Absolute deadline as unix seconds. Overrides the derived default when set. */
  deadline?: bigint;
}

export interface SubmitOptions {
  /** Override the client's destination endpoint id. */
  dstEid?: number;
  /** Override the client's LayerZero options bytes. */
  options?: Hex;
  /** Override the client's native fee (lamports). */
  nativeFee?: bigint;
}

export interface AwaitProofOptions {
  /** Give up after this many milliseconds. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Poll interval in milliseconds. Defaults to 3 seconds. */
  pollMs?: number;
}

const DEFAULT_EPOCHS = 5;
const DEFAULT_DEADLINE_SECONDS = 3600; // 1 hour
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
    this.computeBlobFn = opts.computeBlob ?? defaultComputeBlob;

    const injected = opts.fetch;
    if (injected) {
      this.fetchFn = injected;
    } else if (typeof globalThis.fetch === "function") {
      this.fetchFn = (url, init) =>
        globalThis.fetch(url, {
          method: init.method,
          body: init.body,
          headers: init.headers,
        });
    } else {
      throw new Error("no fetch available; pass a fetch implementation in options");
    }
  }

  /**
   * Encode raw bytes into the commitment fields: derive the blob id locally, pick
   * the storage duration, and compute the deadline. No chain interaction happens
   * here. Fails loudly if the blob id cannot be derived. Identical to the EVM path.
   */
  async encode(data: Uint8Array, opts: EncodeOptions = {}): Promise<EncodedIntent> {
    if (data.length === 0) throw new Error("cannot store empty data");

    const { blobId, size, encodingType } = await this.computeBlobFn(data);
    if (size !== data.length) {
      throw new Error(`computeBlob reported size ${size} but data is ${data.length} bytes`);
    }

    const storageEpochs = opts.epochs ?? this.defaultEpochs;
    const deadline =
      opts.deadline ?? BigInt(Math.floor(Date.now() / 1000) + this.deadlineSeconds);

    return { blobId, size, encodingType, storageEpochs, deadline };
  }

  /**
   * Submit the intent on-chain via the backend's `submit_intent` instruction.
   * Returns the intent id parsed from the `IntentSubmitted` event logs. Fails
   * loudly if the backend yields no intent id.
   */
  async submit(encoded: EncodedIntent, opts: SubmitOptions = {}): Promise<{ intentId: Hex }> {
    const result = await this.chain.submitIntent({
      blobId: encoded.blobId,
      size: encoded.size,
      encodingType: encoded.encodingType,
      storageEpochs: encoded.storageEpochs,
      deadline: encoded.deadline,
      dstEid: opts.dstEid ?? this.dstEid,
      options: opts.options ?? this.options,
      nativeFee: opts.nativeFee ?? this.nativeFee,
    });

    if (!result.intentId) {
      throw new Error(
        "submit_intent produced no IntentSubmitted event; cannot determine intent id",
      );
    }
    return { intentId: result.intentId };
  }

  /**
   * Upload the raw blob bytes out-of-band to the relayer:
   * `POST {relayerUrl}/blob/{intentId}` with the bytes as the raw body. Throws a
   * `RelayerUploadError` carrying the relayer's reason on any non-2xx.
   */
  async upload(intentId: Hex, data: Uint8Array): Promise<void> {
    const url = `${this.relayerUrl}/blob/${intentId}`;
    const res = await this.fetchFn(url, {
      method: "POST",
      body: data,
      headers: { "content-type": "application/octet-stream" },
    });

    if (!res.ok) {
      let reason = "";
      try {
        reason = await res.text();
      } catch {
        reason = "(no response body)";
      }
      throw new RelayerUploadError(intentId, res.status, reason);
    }
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
      const state = await this.chain.readIntent(intentId);
      if (state && state.executed) {
        return { blobId: state.committedBlobId, endEpoch: state.endEpoch };
      }
      if (Date.now() >= deadline) {
        throw new ProofTimeoutError(intentId, timeoutMs);
      }
      await sleep(pollMs);
    }
  }

  /**
   * One-call flow: encode -> submit -> upload -> awaitProof. Returns the verified
   * `{ intentId, blobId, endEpoch }`. Every step fails loudly; no value is
   * fabricated on error. (Solana has no separate quote step: the LayerZero fee is
   * passed as `nativeFee` on the `submit_intent` instruction.)
   */
  async store(
    data: Uint8Array,
    opts: EncodeOptions & SubmitOptions & AwaitProofOptions = {},
  ): Promise<StoreResult> {
    const encoded = await this.encode(data, opts);
    const { intentId } = await this.submit(encoded, opts);
    await this.upload(intentId, data);
    const { blobId, endEpoch } = await this.awaitProof(intentId, opts);
    return { intentId, blobId, endEpoch };
  }
}

/** Factory mirror of `new BosphorSolanaClient(opts)`. */
export function createBosphorSolanaClient(
  opts: BosphorSolanaClientOptions,
): BosphorSolanaClient {
  return new BosphorSolanaClient(opts);
}

export { ProofTimeoutError, RelayerUploadError };
