/**
 * An HTTP-only `SolanaChain` backend for the SDK's BosphorSolanaClient, built on
 * the proven devnet submit path (submit-intent-ix.ts) instead of the SDK's
 * websocket-confirming default backend. Every RPC call goes through a 429-aware
 * backoff and confirmation polls getSignatureStatuses, so it survives the public
 * devnet RPC's rate limits. Also exposes the escrow reads + refund the priced
 * e2e (scripts/test/e2e-priced-solana.ts) asserts against.
 */

import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { decodeIntentState, findIntentSubmittedIntentId } from "../../../sdk/src/solana/program.ts";

type Hex = `0x${string}`;

// Structural mirrors of the SDK's SolanaChain surface (sdk/src/solana/client.ts).
// Declared here rather than imported so this package's typecheck does not pull
// the SDK's fetch-based store flow under a different @types/node; the e2e passes
// this backend to BosphorSolanaClient, which checks the shape structurally.
export interface SolanaSubmitFields {
  blobId: Hex;
  size: number;
  encodingType: number;
  storageEpochs: number;
  deadline: bigint;
  dstEid: number;
  options: Hex;
  nativeFee: bigint;
  escrowAmount?: bigint;
}
export interface SolanaSubmitResult {
  intentId: Hex;
  signature: string;
}
export interface SolanaIntentState {
  executed: boolean;
  committedBlobId: Hex;
  endEpoch: bigint;
}
export interface SolanaChain {
  submitIntent(fields: SolanaSubmitFields): Promise<SolanaSubmitResult>;
  readIntent(intentId: Hex): Promise<SolanaIntentState | null>;
}
import { DEVNET_GENESIS_HASH, escrowPda, intentPda } from "./config.ts";
import { sendPolled, withBackoff } from "./rpc.ts";
import { buildInitNonceIx, buildRefundEscrowIx, buildSubmitIntentTx, toBytes32 } from "./submit-intent-ix.ts";
import { decodeEscrowVault, encodeRefundEscrowData, type EscrowVault, type TxMeta } from "./escrow.ts";

export interface HttpSolanaChain extends SolanaChain {
  readonly conn: Connection;
  readonly wallet: Keypair;
  /** The escrow vault and its total lamports (escrow + rent), or null once closed. */
  readEscrow(intentId: Hex): Promise<{ vault: EscrowVault; lamports: bigint; address: PublicKey } | null>;
  /** Send refund_escrow (wallet is refunder, `payer` = vault.payer); returns the signature. */
  refund(intentId: Hex, payer: Uint8Array): Promise<string>;
  /** Most recent confirmed signature touching an account (e.g. the escrow close). */
  latestSignature(address: PublicKey): Promise<string | null>;
  /** Fee + pre/post balances + account keys of a confirmed transaction. */
  txMeta(sig: string): Promise<{ meta: TxMeta; keys: string[] }>;
  /** Unix time of the latest confirmed block (the program's Clock, near enough). */
  chainTime(): Promise<bigint>;
}

/** Base58 form of a 32-byte public key (for logs and account-key lookups). */
export function base58(bytes: Uint8Array): string {
  return new PublicKey(bytes).toBase58();
}

/** Throw unless the RPC is Solana devnet: this e2e must never touch mainnet. */
export async function assertDevnet(conn: Connection): Promise<void> {
  const genesis = await withBackoff(() => conn.getGenesisHash());
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new Error(`refusing to run: RPC genesis ${genesis} is not Solana devnet`);
  }
}

export function createHttpSolanaChain(conn: Connection, wallet: Keypair): HttpSolanaChain {
  let nonceInitChecked = false;

  return {
    conn,
    wallet,

    // Note: `f.options` is ignored. The builder always attaches the type-3
    // executor options proven on devnet (lzReceive gas 200000), the same as
    // submit-intent.ts.
    async submitIntent(f: SolanaSubmitFields): Promise<SolanaSubmitResult> {
      // The LZ outbound nonce PDA must exist before the first send on this
      // pathway. Init it once per run, idempotently: if it already exists the
      // preflight simulation rejects the init before any fee is charged (same
      // handling as submit-intent.ts).
      if (!nonceInitChecked) {
        try {
          await sendPolled(conn, new Transaction().add(buildInitNonceIx(wallet.publicKey, f.dstEid)), wallet);
        } catch (e) {
          if (!/already in use|custom program error: 0x0\b/i.test(String((e as Error).message))) throw e;
        }
        nonceInitChecked = true;
      }

      const built = await buildSubmitIntentTx(conn, {
        sender: wallet.publicKey,
        blobIdHex: f.blobId,
        size: f.size,
        encodingType: f.encodingType,
        storageEpochs: f.storageEpochs,
        deadline: f.deadline,
        nativeFee: f.nativeFee,
        escrowAmount: f.escrowAmount ?? 0n,
        dstEid: f.dstEid,
      });
      const signature = await sendPolled(conn, built.tx, wallet);
      const tx = await withBackoff(() =>
        conn.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
      );
      const emitted = findIntentSubmittedIntentId(tx?.meta?.logMessages ?? []);
      if (emitted && emitted !== built.intentIdHex) {
        throw new Error(`intent id mismatch: derived ${built.intentIdHex}, event emitted ${emitted}`);
      }
      return { intentId: built.intentIdHex, signature };
    },

    async readIntent(intentId: Hex): Promise<SolanaIntentState | null> {
      const info = await withBackoff(() => conn.getAccountInfo(intentPda(toBytes32(intentId))));
      if (!info) return null;
      const d = decodeIntentState(new Uint8Array(info.data));
      return { executed: d.executed, committedBlobId: d.committedBlobId, endEpoch: d.endEpoch };
    },

    async readEscrow(intentId: Hex) {
      const address = escrowPda(toBytes32(intentId));
      const info = await withBackoff(() => conn.getAccountInfo(address));
      if (!info) return null;
      return { vault: decodeEscrowVault(new Uint8Array(info.data)), lamports: BigInt(info.lamports), address };
    },

    async refund(intentId: Hex, payer: Uint8Array): Promise<string> {
      const id = toBytes32(intentId);
      const ix = buildRefundEscrowIx(wallet.publicKey, new PublicKey(payer), id, encodeRefundEscrowData(id));
      return sendPolled(conn, new Transaction().add(ix), wallet);
    },

    async latestSignature(address: PublicKey): Promise<string | null> {
      const sigs = await withBackoff(() =>
        conn.getSignaturesForAddress(address, { limit: 1 }, "confirmed"),
      );
      return sigs[0]?.signature ?? null;
    },

    async txMeta(sig: string) {
      const tx = await withBackoff(() =>
        conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
      );
      if (!tx?.meta) throw new Error(`transaction ${sig} not found`);
      const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
      return {
        meta: {
          fee: tx.meta.fee,
          preBalances: tx.meta.preBalances,
          postBalances: tx.meta.postBalances,
          logMessages: tx.meta.logMessages ?? [],
        },
        keys,
      };
    },

    async chainTime(): Promise<bigint> {
      const slot = await withBackoff(() => conn.getSlot("confirmed"));
      const t = await withBackoff(() => conn.getBlockTime(slot));
      if (t === null) throw new Error(`no block time for slot ${slot}`);
      return BigInt(t);
    },
  };
}
