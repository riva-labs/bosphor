/**
 * Default `@solana/web3.js`-backed `SolanaChain` implementation.
 *
 * This is the real backend for the Solana adapter. It is IDL-free and Anchor-free:
 * it builds the `submit_intent` instruction with the explicit codec in
 * `./program.ts` (Anchor-style discriminator + borsh args), derives the PDAs from
 * the on-chain seeds, sends the transaction, and reads + decodes the `IntentState`
 * PDA. The canonical intent id is derived from the on-chain nonce with the shared
 * `deriveIntentId` (so the intent PDA can be addressed) and then cross-checked
 * against the `IntentSubmitted` event in the confirmed transaction.
 *
 * Only `@solana/web3.js` is needed, as an optional peer dependency loaded through a
 * lazy dynamic import (the specifier is held in a variable so TypeScript never
 * resolves it at compile time), exactly like the `@mysten/walrus` seam in
 * `../blob.ts`. Unit tests inject a fake `SolanaChain` and never reach this file, so
 * the Solana stack stays out of `npm test` and `tsc`.
 */

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { Hex } from "../types.js";
import { deriveIntentId } from "../commitment-codec.js";
import { decodeIntentState } from "./proof.js";
import { encodeSubmitIntentData, findIntentSubmittedIntentId } from "./program.js";
import type { SolanaChain, SolanaIntentState, SolanaSubmitFields, SolanaSubmitResult } from "./client.js";

/** The Bosphor Solana adapter program id (see `contracts/solana/programs/bosphor-adapter`). */
export const BOSPHOR_PROGRAM_ID = "7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF";

/** On-chain PDA seeds, mirrored from `solana/.../constants.rs`. */
const STORE_SEED = "store";
const PEER_SEED = "peer";
const INTENT_SEED = "intent";
const NONCE_SEED = "nonce";
const ESCROW_SEED = "escrow";

/** A LayerZero endpoint account appended to `submit_intent` as a remaining account. */
export interface SolanaAccountMetaInput {
  /** A `@solana/web3.js` `PublicKey` or a base58 address string. */
  pubkey: unknown;
  isSigner: boolean;
  isWritable: boolean;
}

export interface DefaultSolanaChainOptions {
  /** A `@solana/web3.js` `Connection` (any commitment). */
  connection: unknown;
  /** A funded `@solana/web3.js` `Keypair` (the payer and submitter). */
  wallet: unknown;
  /** Program id override; defaults to {@link BOSPHOR_PROGRAM_ID}. */
  programId?: string;
  /**
   * The LayerZero endpoint `send` accounts appended to `submit_intent` as
   * remaining accounts, already assembled per the deployed LZ Solana config (the
   * Store PDA must appear at remaining-account index 1). These are deployment
   * specific and are validated on devnet; the SDK does not synthesize them.
   */
  endpointAccounts?: SolanaAccountMetaInput[];
  /**
   * Compute-unit limit prepended as a ComputeBudget instruction. `submit_intent`
   * makes a CPI into the LayerZero endpoint `send`, which routinely exceeds the
   * 200k-CU per-instruction default; a real devnet submit needs ~400k. Omit to
   * leave the cluster default in place.
   */
  computeUnitLimit?: number;
  /**
   * Priority fee in micro-lamports per compute unit, prepended as a ComputeBudget
   * instruction. Omit to send at the base fee.
   */
  priorityMicroLamports?: number;
}

function toHex(bytes: Uint8Array): Hex {
  return ("0x" + bytesToHex(bytes)) as Hex;
}

function bytes32(hex: Hex): Uint8Array {
  const b = hexToBytes(hex.startsWith("0x") ? hex.slice(2) : hex);
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
}

/**
 * Construct the default Solana backend. `@solana/web3.js` is pulled in via a lazy
 * dynamic import on first use; if it is not installed this throws loudly with
 * guidance rather than silently fabricating a result. No IDL and no Anchor runtime
 * are required: the program's binary interface lives in `./program.ts`.
 */
export async function createDefaultSolanaChain(
  opts: DefaultSolanaChainOptions,
): Promise<SolanaChain> {
  const web3Spec = "@solana/web3.js";

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let web3: any;
  try {
    web3 = await import(web3Spec);
  } catch (err) {
    throw new Error(
      "the default Solana backend requires the optional peer dependency " +
        "'@solana/web3.js'. Install it (npm install @solana/web3.js) or implement the " +
        `SolanaChain interface yourself. Underlying error: ${String(err)}`,
    );
  }

  const {
    PublicKey,
    Transaction,
    TransactionInstruction,
    SystemProgram,
    ComputeBudgetProgram,
    sendAndConfirmTransaction,
  } = web3;
  const programId = new PublicKey(opts.programId ?? BOSPHOR_PROGRAM_ID);
  const connection: any = opts.connection;
  const payer: any = opts.wallet;
  const payerKey: any = payer.publicKey ?? payer;
  const enc = new TextEncoder();

  const pda = (seeds: Array<Uint8Array>): any =>
    PublicKey.findProgramAddressSync(seeds, programId)[0];

  const [storePda] = PublicKey.findProgramAddressSync([enc.encode(STORE_SEED)], programId);
  const noncePda = (owner: any): any => pda([enc.encode(NONCE_SEED), owner.toBytes()]);
  const intentPda = (intentId: Hex): any => pda([enc.encode(INTENT_SEED), bytes32(intentId)]);
  const escrowPda = (intentId: Hex): any => pda([enc.encode(ESCROW_SEED), bytes32(intentId)]);
  const peerPda = (dstEid: number): any => {
    const eidBe = new Uint8Array(4);
    new DataView(eidBe.buffer).setUint32(0, dstEid, false); // big-endian, matches to_be_bytes
    return pda([enc.encode(PEER_SEED), storePda.toBytes(), eidBe]);
  };

  // The current per-sender nonce (0 if the SenderNonce PDA does not exist yet).
  // SenderNonce layout: 8-byte discriminator + nonce (u64 LE) + bump.
  async function currentNonce(owner: any): Promise<bigint> {
    const info = await connection.getAccountInfo(noncePda(owner));
    if (!info) return 0n;
    const d = new Uint8Array(info.data);
    return new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(8, true);
  }

  const chain: SolanaChain = {
    async submitIntent(fields: SolanaSubmitFields): Promise<SolanaSubmitResult> {
      const nonce = await currentNonce(payerKey);

      // Derive the canonical intent id from the on-chain nonce so the intent PDA
      // can be addressed. This uses the same shared codec as EVM/Sui, so the id
      // matches; it is cross-checked against the emitted event below.
      const intentIdBytes = deriveIntentId(
        {
          blobId: bytes32(fields.blobId),
          size: fields.size,
          encodingType: fields.encodingType,
          storageEpochs: fields.storageEpochs,
          deadline: fields.deadline,
        },
        payerKey.toBytes(),
        nonce,
      );
      const intentId = toHex(intentIdBytes);

      const data = Buffer.from(
        encodeSubmitIntentData({
          blobId: fields.blobId,
          size: fields.size,
          encodingType: fields.encodingType,
          storageEpochs: fields.storageEpochs,
          deadline: fields.deadline,
          dstEid: fields.dstEid,
          options: hexToBytes(fields.options.startsWith("0x") ? fields.options.slice(2) : fields.options),
          nativeFee: fields.nativeFee,
          escrowAmount: fields.escrowAmount ?? 0n,
        }),
      );

      const keys = [
        { pubkey: payerKey, isSigner: true, isWritable: true },
        { pubkey: noncePda(payerKey), isSigner: false, isWritable: true },
        { pubkey: intentPda(intentId), isSigner: false, isWritable: true },
        { pubkey: escrowPda(intentId), isSigner: false, isWritable: true },
        { pubkey: storePda, isSigner: false, isWritable: false },
        { pubkey: peerPda(fields.dstEid), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ...(opts.endpointAccounts ?? []).map((m) => ({
          pubkey: typeof m.pubkey === "string" ? new PublicKey(m.pubkey) : m.pubkey,
          isSigner: m.isSigner,
          isWritable: m.isWritable,
        })),
      ];

      const ix = new TransactionInstruction({ programId, keys, data });

      // Prepend ComputeBudget instructions when configured: the submit_intent CPI
      // into the LayerZero endpoint routinely needs more than the 200k-CU default.
      const tx = new Transaction();
      if (opts.computeUnitLimit) {
        tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: opts.computeUnitLimit }));
      }
      if (opts.priorityMicroLamports) {
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }));
      }
      tx.add(ix);

      const signature: string = await sendAndConfirmTransaction(connection, tx, [payer]);

      // Cross-check the predicted id against the IntentSubmitted event.
      const txInfo = await connection.getTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      const logs: string[] | undefined = txInfo?.meta?.logMessages;
      const fromEvent = logs ? findIntentSubmittedIntentId(logs) : null;
      if (fromEvent && fromEvent !== intentId) {
        throw new Error(
          `intent id mismatch: derived ${intentId} but the IntentSubmitted event emitted ${fromEvent}`,
        );
      }

      return { intentId, signature };
    },

    async readIntent(intentId: Hex): Promise<SolanaIntentState | null> {
      const info = await connection.getAccountInfo(intentPda(intentId));
      if (!info) return null;
      const decoded = decodeIntentState(new Uint8Array(info.data));
      return {
        executed: decoded.executed,
        committedBlobId: decoded.committedBlobId,
        endEpoch: decoded.endEpoch,
      };
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return chain;
}
