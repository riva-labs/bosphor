/**
 * Builds the `submit_intent` transaction for the Bosphor Solana adapter, shared
 * by `submit-intent.ts` (operator tool), `measure-cu.ts` (compute-unit
 * simulation), and the priced e2e (scripts/test/e2e-priced-solana.ts).
 *
 * Reads the on-chain per-sender nonce to derive the canonical intent id, builds
 * type-3 executor options, and appends the LayerZero endpoint `send` accounts
 * (the Store PDA lands at remaining_accounts[1], as the program requires).
 * Read-only against the RPC: it sends nothing.
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import { Options } from "@layerzerolabs/lz-v2-utilities";
import { encodeSubmitIntentData } from "../../../sdk/src/solana/program.ts";
import { deriveIntentId, type Commitment } from "../../../sdk/src/commitment-codec.ts";
import {
  BOSPHOR_PROGRAM_ID,
  ENDPOINT_ID,
  SUI_TESTNET_EID,
  ULN_ID,
  escrowPda,
  intentPda,
  noncePda,
  peerPda,
  storePda,
} from "./config.ts";
import { withBackoff } from "./rpc.ts";

/** Default Sui receiver peer (the `bosphor_lz` package on Sui testnet). */
export const DEFAULT_SUI_RECEIVER =
  "0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5";

/** submit_intent CPIs the LZ endpoint `send`, which needs well over the 200k default. */
export const SUBMIT_INTENT_CU_LIMIT = 400_000;

export interface SubmitIntentParams {
  sender: PublicKey;
  blobIdHex: string;
  size: number;
  encodingType: number;
  storageEpochs: number;
  /** Unix seconds. */
  deadline: bigint;
  /** Lamports attached for the LayerZero forward-leg `send`. */
  nativeFee: bigint;
  /** Lamports deposited into the per-intent escrow vault (0 = unpriced). */
  escrowAmount: bigint;
  dstEid?: number;
  suiReceiver?: string;
  /** Executor lzReceive gas for the destination (default 200000). */
  lzReceiveGas?: number;
  /** Compute-unit limit instruction; null omits it (e.g. to measure the default). */
  computeUnitLimit?: number | null;
}

export interface BuiltSubmitIntent {
  tx: Transaction;
  intentId: Uint8Array;
  intentIdHex: `0x${string}`;
  intent: PublicKey;
  escrow: PublicKey;
  senderNonce: bigint;
  /** Idempotent LZ outbound-nonce PDA init for this pathway (send before first submit). */
  initNonceIx: TransactionInstruction;
}

export function toBytes32(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const b = Buffer.from(h, "hex");
  if (b.length !== 32) throw new Error(`expected 32 bytes, got ${b.length}`);
  return b;
}

/**
 * Idempotent LZ outbound-nonce PDA init for the Store -> Sui pathway. Send it
 * before the first submit on a pathway (a duplicate init fails preflight, free).
 */
export function buildInitNonceIx(
  sender: PublicKey,
  dstEid: number = SUI_TESTNET_EID,
  suiReceiver: string = DEFAULT_SUI_RECEIVER,
): TransactionInstruction {
  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);
  return endpoint.initOAppNonce(sender, dstEid, storePda(), toBytes32(suiReceiver));
}

/** Current per-sender nonce (0 if the SenderNonce PDA does not exist yet). */
export async function readSenderNonce(conn: Connection, sender: PublicKey): Promise<bigint> {
  // Layout: 8-byte discriminator ++ nonce(u64 LE) ++ bump(u8).
  const acct = await withBackoff(() => conn.getAccountInfo(noncePda(sender)));
  return acct ? new DataView(acct.data.buffer, acct.data.byteOffset).getBigUint64(8, true) : 0n;
}

export async function buildSubmitIntentTx(
  conn: Connection,
  p: SubmitIntentParams,
): Promise<BuiltSubmitIntent> {
  const dstEid = p.dstEid ?? SUI_TESTNET_EID;
  const suiReceiver = p.suiReceiver ?? DEFAULT_SUI_RECEIVER;
  const store = storePda();
  const peer = peerPda(store, dstEid);
  const noncePdaKey = noncePda(p.sender);

  const senderNonce = await readSenderNonce(conn, p.sender);
  const commitment: Commitment = {
    blobId: toBytes32(p.blobIdHex),
    size: p.size,
    encodingType: p.encodingType,
    storageEpochs: p.storageEpochs,
    deadline: p.deadline,
  };
  const intentId = deriveIntentId(commitment, p.sender.toBytes(), senderNonce);
  const intent = intentPda(intentId);
  const escrow = escrowPda(intentId);

  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);
  const uln = new UlnProgram.Uln(ULN_ID);
  const initNonceIx = buildInitNonceIx(p.sender, dstEid, suiReceiver);

  // sender/receiver as hex strings: the SDK's arrayify() accepts hex (and bytes)
  // but rejects PublicKey objects.
  const path = {
    sender: "0x" + Buffer.from(store.toBytes()).toString("hex"),
    dstEid,
    receiver: suiReceiver,
  };
  // The LZ SDK bundles its own @solana/web3.js; normalize returned pubkeys to our
  // copy so Transaction serialization doesn't mix two PublicKey classes.
  const rawSendAccounts = await withBackoff(() =>
    endpoint.getSendIXAccountMetaForCPI(conn as never, p.sender as never, path, uln, "confirmed"),
  );
  const sendAccounts = rawSendAccounts.map(
    (a: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }) => ({
      pubkey: new PublicKey(a.pubkey.toBase58()),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    }),
  );

  const options = Options.newOptions()
    .addExecutorLzReceiveOption(p.lzReceiveGas ?? 200_000, 0)
    .toBytes();
  const data = Buffer.from(
    encodeSubmitIntentData({
      blobId: p.blobIdHex as `0x${string}`,
      size: p.size,
      encodingType: p.encodingType,
      storageEpochs: p.storageEpochs,
      deadline: p.deadline,
      dstEid,
      options: new Uint8Array(options),
      nativeFee: p.nativeFee,
      escrowAmount: p.escrowAmount,
    }),
  );

  const ix = new TransactionInstruction({
    programId: BOSPHOR_PROGRAM_ID,
    keys: [
      { pubkey: p.sender, isSigner: true, isWritable: true },
      { pubkey: noncePdaKey, isSigner: false, isWritable: true },
      { pubkey: intent, isSigner: false, isWritable: true },
      // M4: per-intent escrow vault, created + funded here (between intent and store).
      { pubkey: escrow, isSigner: false, isWritable: true },
      { pubkey: store, isSigner: false, isWritable: false },
      { pubkey: peer, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ...sendAccounts,
    ],
    data,
  });

  const tx = new Transaction();
  const cuLimit = p.computeUnitLimit === undefined ? SUBMIT_INTENT_CU_LIMIT : p.computeUnitLimit;
  if (cuLimit !== null) tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
  tx.add(ix);

  return {
    tx,
    intentId,
    intentIdHex: ("0x" + Buffer.from(intentId).toString("hex")) as `0x${string}`,
    intent,
    escrow,
    senderNonce,
    initNonceIx,
  };
}

/** Build the permissionless `refund_escrow` instruction (refunder pays the fee). */
export function buildRefundEscrowIx(
  refunder: PublicKey,
  payer: PublicKey,
  intentId: Uint8Array,
  data: Uint8Array,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: BOSPHOR_PROGRAM_ID,
    keys: [
      { pubkey: refunder, isSigner: true, isWritable: true },
      { pubkey: payer, isSigner: false, isWritable: true },
      { pubkey: escrowPda(intentId), isSigner: false, isWritable: true },
    ],
    data: Buffer.from(data),
  });
}
