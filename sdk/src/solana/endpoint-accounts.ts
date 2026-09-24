/**
 * LayerZero `send` accounts for the Solana `submit_intent` instruction, plus a
 * one-call client helper that fills every deployment detail from a network preset.
 *
 * `submit_intent` makes a CPI into the LayerZero endpoint `send`, which needs a
 * fixed list of accounts (endpoint, ULN, executor, DVN config PDAs, and the payer)
 * appended as remaining accounts. The list is deterministic for a pathway
 * (sender = the Bosphor Store PDA, destination = Sui), so there are two ways to
 * get it:
 *
 *  - {@link testnetEndpointAccounts}: a published snapshot of the testnet list,
 *    no extra dependency. Only the payer slot varies.
 *  - {@link resolveEndpointAccounts}: resolves the live list on-chain with
 *    `getSendIXAccountMetaForCPI` from `@layerzerolabs/lz-solana-sdk-v2` (an
 *    optional peer). Use it if LayerZero changes the pathway's send config.
 */

import type { SolanaAccountMetaInput } from "./backend.js";
import { createDefaultSolanaChain } from "./backend.js";
import {
  BosphorSolanaClient,
  type BosphorSolanaClientOptions,
  type SolanaChain,
} from "./client.js";
import { TESTNET, type BosphorNetwork } from "../networks.js";

/** Placeholder in {@link TESTNET_SEND_ACCOUNTS} for the paying wallet. */
export const PAYER_PLACEHOLDER = "__PAYER__";

/**
 * Snapshot of the LayerZero `send` accounts for the testnet pathway
 * (Bosphor Solana devnet adapter -> Sui testnet, EID 40378), captured with
 * `getSendIXAccountMetaForCPI`. The Store PDA sits at index 1, as the adapter
 * requires. {@link PAYER_PLACEHOLDER} marks the payer slot.
 */
export const TESTNET_SEND_ACCOUNTS: ReadonlyArray<{ pubkey: string; isWritable: boolean }> = [
  { pubkey: "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6", isWritable: false },
  { pubkey: "Gn2Lib6i7iqEibZRjvp3pcDm8cJfCHgTDF9Aek1XnPrE", isWritable: false },
  { pubkey: "7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH", isWritable: false },
  { pubkey: "4StF9U3ne6o2Dbg7ACmQBgBnRUgyzRqL9GAzxccEeUvr", isWritable: false },
  { pubkey: "4VWUmQUDncvgK3mW9QRf852nX5a7PZEcy7uGTkhxjr3w", isWritable: false },
  { pubkey: "526PeNZfw8kSnDU4nmzJFVJzJWNhwmZykEyJr5XWz5Fv", isWritable: false },
  { pubkey: "2uk9pQh3tB5ErV7LGQJcbWjb4KeJ2UJki5qJZ8QG56G3", isWritable: false },
  { pubkey: "8SnBx94u2WgC5AYVG3fqAx9bs9dowCyevbxriiDbcVzv", isWritable: true },
  { pubkey: "F8E8QGhKmHEx2esh5LpVizzcP4cHYhzXdXTwg9w3YYY2", isWritable: false },
  { pubkey: "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6", isWritable: false },
  { pubkey: "2XgGZG4oP29U3w5h4nTk1V2LFHL23zKDPJjs3psGzLKQ", isWritable: false },
  { pubkey: "2wdY34oNMjyTdLNKjEpZYQgq49aod24LbYSJjfxVng56", isWritable: false },
  { pubkey: "E191aQS8U6WHKBro64S7UdrqbSfWyN6qRJY8iL9uKxmN", isWritable: false },
  { pubkey: PAYER_PLACEHOLDER, isWritable: true },
  { pubkey: "7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH", isWritable: false },
  { pubkey: "11111111111111111111111111111111", isWritable: false },
  { pubkey: "7n1YeBMVEUCJ4DscKAcpVQd6KXU7VpcEcc15ZuMcL4U3", isWritable: false },
  { pubkey: "7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH", isWritable: false },
  { pubkey: "6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn", isWritable: false },
  { pubkey: "AwrbHeCyniXaQhiJZkLhgWdUCteeWSGaSN1sTfLiY7xK", isWritable: true },
  { pubkey: "8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP", isWritable: false },
  { pubkey: "CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ", isWritable: false },
  { pubkey: "HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW", isWritable: false },
  { pubkey: "4VDjp6XQaxoZf5RGwiPU9NR1EXSZn2TP4ATMmiSzLfhb", isWritable: true },
  { pubkey: "8ahPGPjEbpgGaZx2NV1iG5Shj7TDwvsjkEDcGWjt94TP", isWritable: false },
  { pubkey: "CSFsUupvJEQQd1F4SsXGACJaxQX4eropQMkGV2696eeQ", isWritable: false },
];

/** A base58 address string or anything with `toBase58()` (a web3.js `PublicKey`). */
export type PublicKeyLike = string | { toBase58(): string };

function toBase58(key: PublicKeyLike): string {
  return typeof key === "string" ? key : key.toBase58();
}

/**
 * The testnet LayerZero `send` accounts with the payer filled in, ready for
 * `createDefaultSolanaChain({ endpointAccounts })`.
 *
 * @param payer - The wallet that signs and pays for `submit_intent`.
 */
export function testnetEndpointAccounts(payer: PublicKeyLike): SolanaAccountMetaInput[] {
  const payerKey = toBase58(payer);
  return TESTNET_SEND_ACCOUNTS.map((a) => ({
    pubkey: a.pubkey === PAYER_PLACEHOLDER ? payerKey : a.pubkey,
    isSigner: false,
    isWritable: a.isWritable,
  }));
}

/** The slice of `@layerzerolabs/lz-solana-sdk-v2` {@link resolveEndpointAccounts} uses. */
export interface LzSolanaSdkLike {
  EndpointProgram: { Endpoint: new (programId: never) => unknown };
  UlnProgram: { Uln: new (programId: never) => unknown };
}

export interface ResolveEndpointAccountsOptions {
  /** A `@solana/web3.js` `Connection`. */
  connection: unknown;
  /** The paying wallet's public key (a `PublicKey` or base58 string). */
  payer: PublicKeyLike;
  /** Network preset; defaults to {@link TESTNET}. */
  network?: BosphorNetwork;
  /** Inject `@layerzerolabs/lz-solana-sdk-v2` (tests, or bundlers that cannot lazy-load). */
  lzSdk?: LzSolanaSdkLike;
  /** Inject the `@solana/web3.js` module (only `PublicKey` is used). */
  web3?: unknown;
}

/**
 * Resolve the live LayerZero `send` accounts for the network's Solana -> Sui
 * pathway with `getSendIXAccountMetaForCPI`. Needs the optional peers
 * `@layerzerolabs/lz-solana-sdk-v2` and `@solana/web3.js`. Returns base58
 * addresses, so the result is independent of the LayerZero SDK's bundled
 * `@solana/web3.js` copy.
 */
export async function resolveEndpointAccounts(
  opts: ResolveEndpointAccountsOptions,
): Promise<SolanaAccountMetaInput[]> {
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
    throw new Error(
      "resolveEndpointAccounts requires the optional peers '@layerzerolabs/lz-solana-sdk-v2' " +
        "and '@solana/web3.js'. Install them, or use testnetEndpointAccounts(payer) instead. " +
        `Underlying error: ${String(err)}`,
    );
  }

  const { PublicKey } = web3;
  const programId = new PublicKey(network.solana.programId);
  const [store] = PublicKey.findProgramAddressSync([new TextEncoder().encode("store")], programId);
  const storeHex =
    "0x" + Array.from(store.toBytes() as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");

  const endpoint = new lz.EndpointProgram.Endpoint(new PublicKey(network.solana.lzEndpointProgram));
  const uln = new lz.UlnProgram.Uln(new PublicKey(network.solana.lzUlnProgram));
  const metas = (await endpoint.getSendIXAccountMetaForCPI(
    opts.connection,
    new PublicKey(toBase58(opts.payer)),
    { sender: storeHex, dstEid: network.sui.eid, receiver: network.sui.packageId },
    uln,
    "confirmed",
  )) as Array<{ pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }>;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return metas.map((m) => ({
    pubkey: m.pubkey.toBase58(),
    isSigner: m.isSigner,
    isWritable: m.isWritable,
  }));
}

export interface CreateSolanaClientFromKeypairOptions
  extends Partial<Omit<BosphorSolanaClientOptions, "chain" | "network">> {
  /** A `@solana/web3.js` `Connection` to the network's cluster. */
  connection: unknown;
  /** A funded `@solana/web3.js` `Keypair` (payer and submitter). */
  wallet: { publicKey: PublicKeyLike };
  /** Network preset; defaults to {@link TESTNET}. */
  network?: BosphorNetwork;
  /**
   * LayerZero `send` accounts. Defaults to {@link testnetEndpointAccounts} for the
   * wallet; pass the result of {@link resolveEndpointAccounts} to use the live list.
   */
  endpointAccounts?: SolanaAccountMetaInput[];
  /** Compute-unit limit override; defaults to `network.solana.computeUnitLimit`. */
  computeUnitLimit?: number;
  /** Priority fee in micro-lamports per compute unit. */
  priorityMicroLamports?: number;
  /** Use a custom chain backend instead of the default web3.js one. */
  chain?: SolanaChain;
}

/**
 * Create a {@link BosphorSolanaClient} from a `Connection` and a `Keypair` in one
 * call. The program id, LayerZero send accounts, options, fee cap, compute budget,
 * destination endpoint id, and relayer URL all come from the network preset
 * (default {@link TESTNET}).
 *
 * @example
 * ```ts
 * import { Connection, Keypair } from "@solana/web3.js";
 * import { TESTNET, createBosphorSolanaClientFromKeypair } from "@bosphor/sdk/solana";
 *
 * const connection = new Connection(TESTNET.solana.rpcUrl, "confirmed");
 * const client = await createBosphorSolanaClientFromKeypair({ connection, wallet: keypair });
 * const { intentId, blobId } = await client.storePriced(bytes);
 * ```
 */
export async function createBosphorSolanaClientFromKeypair(
  opts: CreateSolanaClientFromKeypairOptions,
): Promise<BosphorSolanaClient> {
  const network = opts.network ?? TESTNET;
  if (!opts.wallet?.publicKey) {
    throw new Error("createBosphorSolanaClientFromKeypair requires a wallet Keypair");
  }

  let chain = opts.chain;
  if (!chain) {
    const chainOpts: Parameters<typeof createDefaultSolanaChain>[0] = {
      connection: opts.connection,
      wallet: opts.wallet,
      programId: network.solana.programId,
      endpointAccounts: opts.endpointAccounts ?? testnetEndpointAccounts(opts.wallet.publicKey),
      computeUnitLimit: opts.computeUnitLimit ?? network.solana.computeUnitLimit,
    };
    if (opts.priorityMicroLamports !== undefined) {
      chainOpts.priorityMicroLamports = opts.priorityMicroLamports;
    }
    chain = await createDefaultSolanaChain(chainOpts);
  }

  const clientOpts: BosphorSolanaClientOptions = {
    chain,
    relayerUrl: opts.relayerUrl ?? network.relayerUrl,
    dstEid: opts.dstEid ?? network.sui.eid,
    options: opts.options ?? network.solana.lzOptions,
    nativeFee: opts.nativeFee ?? network.solana.nativeFee,
    network: network.walrusNetwork,
  };
  if (opts.defaultEpochs !== undefined) clientOpts.defaultEpochs = opts.defaultEpochs;
  if (opts.deadlineSeconds !== undefined) clientOpts.deadlineSeconds = opts.deadlineSeconds;
  if (opts.computeBlob !== undefined) clientOpts.computeBlob = opts.computeBlob;
  if (opts.fetch !== undefined) clientOpts.fetch = opts.fetch;

  return new BosphorSolanaClient(clientOpts);
}
