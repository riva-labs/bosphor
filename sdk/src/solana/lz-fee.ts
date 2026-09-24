/**
 * Read-only LayerZero fee quote for the Solana forward leg.
 *
 * Solana has no view calls, so the fee is read by SIMULATING the LayerZero
 * endpoint's `quote` instruction (no signature, nothing is sent) and decoding its
 * return data (`MessagingFee { native_fee: u64, lz_token_fee: u64 }`). The
 * accounts come from `getSendIXAccountMetaForCPI`'s sibling
 * `getQuoteIXAccountMetaForCPI` in `@layerzerolabs/lz-solana-sdk-v2`, an optional
 * peer loaded lazily.
 *
 * The quoted message is the same size as the real `submit_intent` message (the
 * 32-byte intent id plus the 49-byte commitment); the LayerZero fee depends on the
 * message length and options, not on its content.
 */

import { TESTNET, type BosphorNetwork } from "../networks.js";
import type { PublicKeyLike } from "./endpoint-accounts.js";
import { base64ToBytes } from "../base64.js";

/** Byte length of the forward message: intent id (32) ++ commitment (49). */
export const FORWARD_MESSAGE_LEN = 81;

/** Store PDA seed, mirrored from the program. */
const STORE_SEED = "store";

/** Raised when the optional LayerZero Solana SDK peer is not installed. */
export class LzSolanaSdkMissingError extends Error {
  constructor(cause: unknown) {
    super(
      "quoting the Solana LayerZero fee requires the optional peers " +
        "'@layerzerolabs/lz-solana-sdk-v2' and '@solana/web3.js'. Underlying error: " +
        String(cause),
    );
    this.name = "LzSolanaSdkMissingError";
  }
}

export interface QuoteSolanaLzFeeOptions {
  /** A `@solana/web3.js` `Connection` to the network's cluster. */
  connection: object;
  /** Network preset; defaults to {@link TESTNET}. */
  network?: BosphorNetwork;
  /**
   * Fee payer for the simulation. It is never charged, but the cluster requires an
   * existing funded account. Defaults to the Bosphor Store admin read on-chain.
   */
  payer?: PublicKeyLike;
  /** Inject `@layerzerolabs/lz-solana-sdk-v2` (tests, or bundlers that cannot lazy-load). */
  lzSdk?: object;
  /** Inject the `@solana/web3.js` module. */
  web3?: object;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Quote the live LayerZero native fee (lamports) for one Bosphor forward message
 * from Solana to Sui, read-only. Throws {@link LzSolanaSdkMissingError} if the
 * optional peers are missing, and the simulation error on any RPC or program
 * failure (never a fabricated fee).
 */
export async function quoteSolanaLzFee(opts: QuoteSolanaLzFeeOptions): Promise<bigint> {
  const network = opts.network ?? TESTNET;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let lz: any = opts.lzSdk;
  let web3: any = opts.web3;
  try {
    const lzSpec = "@layerzerolabs/lz-solana-sdk-v2";
    const web3Spec = "@solana/web3.js";
    lz ??= await import(lzSpec);
    web3 ??= await import(web3Spec);
  } catch (err) {
    throw new LzSolanaSdkMissingError(err);
  }
  const connection: any = opts.connection;
  const { PublicKey, TransactionInstruction } = web3;

  const programId = new PublicKey(network.solana.programId);
  const [store] = PublicKey.findProgramAddressSync([new TextEncoder().encode(STORE_SEED)], programId);

  let payer: any;
  if (opts.payer !== undefined) {
    payer = new PublicKey(typeof opts.payer === "string" ? opts.payer : opts.payer.toBase58());
  } else {
    // Store layout: 8-byte discriminator ++ admin Pubkey ++ endpoint Pubkey ++ bump.
    const info = await connection.getAccountInfo(store);
    if (!info) throw new Error(`Bosphor Store account ${store.toBase58()} not found on this cluster`);
    payer = new PublicKey(new Uint8Array(info.data).subarray(8, 40));
  }

  const endpointId = new PublicKey(network.solana.lzEndpointProgram);
  const endpoint = new lz.EndpointProgram.Endpoint(endpointId);
  const uln = new lz.UlnProgram.Uln(new PublicKey(network.solana.lzUlnProgram));
  const storeHex =
    "0x" + Array.from(store.toBytes() as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");
  const path = { sender: storeHex, dstEid: network.sui.eid, receiver: network.sui.packageId };

  // First meta is the endpoint program itself (CPI convention); the rest are the
  // quote instruction's accounts.
  const metas = await endpoint.getQuoteIXAccountMetaForCPI(connection, payer, path, uln);
  const ixs = lz.EndpointProgram.instructions;
  const [data] = ixs.quoteStruct.serialize({
    instructionDiscriminator: ixs.quoteInstructionDiscriminator,
    params: {
      sender: store,
      dstEid: network.sui.eid,
      receiver: Array.from(hexToBytes(network.sui.packageId)),
      message: new Uint8Array(FORWARD_MESSAGE_LEN),
      options: hexToBytes(network.solana.lzOptions),
      payInLzToken: false,
    },
  });
  const ix = new TransactionInstruction({
    programId: endpointId,
    keys: metas.slice(1).map((m: any) => ({
      pubkey: new PublicKey(m.pubkey.toBase58()),
      isSigner: m.isSigner,
      isWritable: m.isWritable,
    })),
    data,
  });
  // Simulate with our own web3.js copy (the LZ SDK bundles another one, and mixing
  // classes breaks serialization). No signature is needed or checked.
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new web3.TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const sim = await connection.simulateTransaction(new web3.VersionedTransaction(message), {
    sigVerify: false,
    commitment: "confirmed",
  });
  const returnData = sim?.value?.returnData;
  if (sim?.value?.err || !returnData || returnData.programId !== endpointId.toBase58()) {
    throw new Error(
      `LayerZero quote simulation failed: ${JSON.stringify(sim?.value?.err ?? "no return data")}; ` +
        `logs: ${(sim?.value?.logs ?? []).slice(-5).join(" | ")}`,
    );
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const ret = base64ToBytes(returnData.data[0] as string);
  if (ret.length < 8) throw new Error(`LayerZero quote returned ${ret.length} bytes, expected >= 8`);
  return new DataView(ret.buffer, ret.byteOffset, ret.byteLength).getBigUint64(0, true);
}
