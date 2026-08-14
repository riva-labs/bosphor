/**
 * Default `@solana/web3.js`/Anchor-backed `SolanaChain` implementation.
 *
 * This is the real backend for the Solana adapter: it builds the `submit_intent`
 * instruction, derives the PDAs from the on-chain seeds, sends the transaction,
 * parses the `IntentSubmitted` event to obtain the canonical intent id, and reads
 * + deserializes the `IntentState` PDA for `awaitProof`.
 *
 * `@solana/web3.js` and `@coral-xyz/anchor` are heavy, optional peer dependencies.
 * They are loaded through a lazy dynamic import (import specifiers held in
 * variables so TypeScript never resolves them at compile time), exactly like the
 * `@mysten/walrus` seam in `../blob.ts`. Unit tests inject a fake `SolanaChain` and
 * never reach this file, so the Solana stack stays out of `npm test` and `tsc`.
 */

import type { Hex } from "../types.ts";
import { decodeIntentState } from "./proof.ts";
import type { SolanaChain, SolanaIntentState, SolanaSubmitFields, SolanaSubmitResult } from "./client.ts";

/** The Bosphor Solana adapter program id (see `solana/programs/bosphor-adapter`). */
export const BOSPHOR_PROGRAM_ID = "7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF";

/** On-chain PDA seeds, mirrored from `solana/.../constants.rs`. */
const STORE_SEED = "store";
const PEER_SEED = "peer";
const INTENT_SEED = "intent";

export interface DefaultSolanaChainOptions {
  /** A `@solana/web3.js` `Connection` (any commitment). */
  connection: unknown;
  /** A funded `@solana/web3.js` `Keypair` / wallet-adapter signer (the payer). */
  wallet: unknown;
  /**
   * The Anchor `Program<BosphorAdapter>` bound to the deployed program and an
   * `AnchorProvider` wrapping `connection` + `wallet`. The IDL must expose
   * `submitIntent`, the `IntentSubmitted` event, and the `intentState` account.
   */
  program: unknown;
  /** Program id override; defaults to {@link BOSPHOR_PROGRAM_ID}. */
  programId?: string;
}

function hexToBytes(hex: Hex): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s as Hex;
}

/**
 * Construct the default Solana backend. The `@solana/web3.js` + Anchor stack is
 * pulled in via a lazy dynamic import on first use; if it is not installed this
 * throws loudly with guidance rather than silently fabricating a result.
 *
 * The caller supplies a fully-constructed Anchor `Program` (with its IDL and an
 * `AnchorProvider`), so the SDK does not need to embed the IDL and stays lean. The
 * backend derives PDAs and parses events against that program.
 */
export async function createDefaultSolanaChain(
  opts: DefaultSolanaChainOptions,
): Promise<SolanaChain> {
  const web3Spec = "@solana/web3.js";
  const anchorSpec = "@coral-xyz/anchor";

  /* eslint-disable @typescript-eslint/no-explicit-any */
  let web3: any;
  let anchor: any;
  try {
    [web3, anchor] = await Promise.all([import(web3Spec), import(anchorSpec)]);
  } catch (err) {
    throw new Error(
      "the default Solana backend requires the optional peer dependencies " +
        "'@solana/web3.js' and '@coral-xyz/anchor'. Install them " +
        "(npm install @solana/web3.js @coral-xyz/anchor) or implement the SolanaChain " +
        `interface yourself. Underlying error: ${String(err)}`,
    );
  }

  const { PublicKey } = web3;
  const program: any = opts.program;
  const programId = new PublicKey(opts.programId ?? BOSPHOR_PROGRAM_ID);
  const enc = new TextEncoder();

  const [storePda] = PublicKey.findProgramAddressSync([enc.encode(STORE_SEED)], programId);

  const peerPda = (dstEid: number): any => {
    const eidBe = new Uint8Array(4);
    new DataView(eidBe.buffer).setUint32(0, dstEid, false); // big-endian, matches to_be_bytes
    return PublicKey.findProgramAddressSync(
      [enc.encode(PEER_SEED), storePda.toBytes(), eidBe],
      programId,
    )[0];
  };

  const intentPda = (intentId: Hex): any =>
    PublicKey.findProgramAddressSync(
      [enc.encode(INTENT_SEED), hexToBytes(intentId)],
      programId,
    )[0];

  const noncePda = (payer: any): any =>
    PublicKey.findProgramAddressSync(
      [enc.encode("nonce"), payer.toBytes()],
      programId,
    )[0];

  const payer: any = opts.wallet;
  const payerKey: any = payer.publicKey ?? payer;

  const chain: SolanaChain = {
    async submitIntent(fields: SolanaSubmitFields): Promise<SolanaSubmitResult> {
      const senderNonce = noncePda(payerKey);

      // Build + send submit_intent. Anchor maps camelCase args to the on-chain
      // snake_case ones. The endpoint `send` accounts are appended by the caller's
      // program config as remaining accounts; here we assume the Anchor method
      // builder resolves the required accounts and the caller wired remaining
      // accounts via `.remainingAccounts(...)` on the returned builder if needed.
      const signature: string = await program.methods
        .submitIntent(
          Array.from(hexToBytes(fields.blobId)),
          fields.size,
          fields.encodingType,
          fields.storageEpochs,
          new anchor.BN(fields.deadline.toString()),
          fields.dstEid,
          Buffer.from(hexToBytes(fields.options)),
          new anchor.BN(fields.nativeFee.toString()),
        )
        .accounts({
          payer: payerKey,
          senderNonce,
          store: storePda,
          peer: peerPda(fields.dstEid),
        })
        .rpc();

      // Parse the IntentSubmitted event from the confirmed transaction logs. The
      // canonical intent id is the event's `intent_id`; we never assume the nonce.
      const intentId = await parseIntentSubmitted(
        web3,
        anchor,
        program,
        opts.connection,
        signature,
      );
      if (!intentId) {
        throw new Error(
          `submit_intent tx ${signature} emitted no IntentSubmitted event; ` +
            "cannot determine intent id",
        );
      }
      return { intentId, signature };
    },

    async readIntent(intentId: Hex): Promise<SolanaIntentState | null> {
      const pda = intentPda(intentId);
      const info = await (opts.connection as any).getAccountInfo(pda);
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

  void bytesToHex;
  return chain;
}

/**
 * Parse the `IntentSubmitted` event from a confirmed transaction's logs and return
 * the canonical intent id. Uses Anchor's `EventParser` over the program logs.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
async function parseIntentSubmitted(
  _web3: any,
  anchor: any,
  program: any,
  connection: any,
  signature: string,
): Promise<Hex | null> {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const logs: string[] | undefined = tx?.meta?.logMessages;
  if (!logs) return null;

  const parser = new anchor.EventParser(program.programId, program.coder);
  for (const event of parser.parseLogs(logs)) {
    if (event.name === "IntentSubmitted" || event.name === "intentSubmitted") {
      const id = event.data.intentId ?? event.data.intent_id;
      if (id) {
        const bytes = id instanceof Uint8Array ? id : Uint8Array.from(id as number[]);
        let s = "0x";
        for (const b of bytes) s += b.toString(16).padStart(2, "0");
        return s as Hex;
      }
    }
  }
  return null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
