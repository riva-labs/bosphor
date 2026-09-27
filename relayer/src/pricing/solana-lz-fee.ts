/**
 * Read-only LayerZero fee quote for the Solana -> Sui forward leg.
 *
 * Mirrors `sdk/src/solana/lz-fee.ts`: Solana has no view calls, so the fee is
 * read by SIMULATING the LayerZero endpoint's `quote` instruction (no signature,
 * nothing is sent) and decoding its return data
 * (`MessagingFee { native_fee: u64, lz_token_fee: u64 }`). The accounts come
 * from `getQuoteIXAccountMetaForCPI` in `@layerzerolabs/lz-solana-sdk-v2`.
 *
 * The quoted message has the length of the real `submit_intent` message (32-byte
 * intent id + 49-byte commitment): the fee depends on the length and options,
 * not on the content.
 */

/** Byte length of the forward message: intent id (32) ++ commitment (49). */
export const FORWARD_MESSAGE_LEN = 81;

/** Store PDA seed of the Bosphor Solana adapter. */
const STORE_SEED = 'store';

/** The pathway being priced. */
export interface SolanaLzFeePath {
  /** Bosphor Solana adapter program id (base58). */
  programId: string;
  /** LayerZero v2 endpoint program id (base58). */
  endpointProgram: string;
  /** LayerZero v2 ULN302 program id (base58). */
  ulnProgram: string;
  /** Destination (Sui) LayerZero endpoint id. */
  dstEid: number;
  /** The Sui OApp peer (the Bosphor package id the peer was set to), 0x bytes32. */
  receiver: string;
  /** LayerZero executor options, 0x hex. */
  options: string;
}

/**
 * The modules and RPC the quote needs, injected so unit tests run on fakes and
 * never load the Solana stack. Typed loosely on purpose: the LZ SDK bundles its
 * own `@solana/web3.js` copy, so its classes are bridged through base58 strings.
 */
export interface SolanaLzFeeDeps {
  /** A `@solana/web3.js` `Connection`. */
  connection: any;
  /** The `@solana/web3.js` module. */
  web3: any;
  /** The `@layerzerolabs/lz-solana-sdk-v2` module. */
  lz: any;
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]*$/.test(h) || h.length % 2 !== 0) throw new Error(`invalid hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Quote the live LayerZero native fee (lamports) for one Bosphor forward message
 * from Solana to Sui. Throws on any RPC, account or simulation failure: the fee
 * is never made up.
 */
export async function quoteSolanaLzFeeLamports(
  deps: SolanaLzFeeDeps,
  path: SolanaLzFeePath,
): Promise<bigint> {
  const { connection, web3, lz } = deps;
  const { PublicKey, TransactionInstruction } = web3;

  const programId = new PublicKey(path.programId);
  const [store] = PublicKey.findProgramAddressSync(
    [new TextEncoder().encode(STORE_SEED)],
    programId,
  );

  // Simulation fee payer: never charged, but the cluster needs an existing
  // account. The Store admin is one. Store layout: disc(8) ++ admin(32) ++ ...
  const storeInfo = await connection.getAccountInfo(store);
  if (!storeInfo) {
    throw new Error(`Bosphor Store account ${store.toBase58()} not found on this cluster`);
  }
  const payer = new PublicKey(new Uint8Array(storeInfo.data).subarray(8, 40));

  const endpointId = new PublicKey(path.endpointProgram);
  const endpoint = new lz.EndpointProgram.Endpoint(endpointId);
  const uln = new lz.UlnProgram.Uln(new PublicKey(path.ulnProgram));
  const storeHex =
    '0x' +
    Array.from(store.toBytes() as Uint8Array, (b) => b.toString(16).padStart(2, '0')).join('');
  const lzPath = { sender: storeHex, dstEid: path.dstEid, receiver: path.receiver };

  // First meta is the endpoint program itself (CPI convention); the rest are the
  // quote instruction's accounts.
  const metas = await endpoint.getQuoteIXAccountMetaForCPI(connection, payer, lzPath, uln);
  const ixs = lz.EndpointProgram.instructions;
  const [data] = ixs.quoteStruct.serialize({
    instructionDiscriminator: ixs.quoteInstructionDiscriminator,
    params: {
      sender: store,
      dstEid: path.dstEid,
      receiver: Array.from(hexToBytes(path.receiver)),
      message: new Uint8Array(FORWARD_MESSAGE_LEN),
      options: hexToBytes(path.options),
      payInLzToken: false,
    },
  });
  const ix = new TransactionInstruction({
    programId: endpointId,
    keys: (
      metas as Array<{ pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }>
    )
      .slice(1)
      .map((m) => ({
        pubkey: new PublicKey(m.pubkey.toBase58()),
        isSigner: m.isSigner,
        isWritable: m.isWritable,
      })),
    data,
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new web3.TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const sim = await connection.simulateTransaction(new web3.VersionedTransaction(message), {
    sigVerify: false,
    commitment: 'confirmed',
  });
  const returnData = sim?.value?.returnData;
  if (sim?.value?.err || !returnData || returnData.programId !== endpointId.toBase58()) {
    throw new Error(
      `LayerZero quote simulation failed: ${JSON.stringify(sim?.value?.err ?? 'no return data')}; ` +
        `logs: ${((sim?.value?.logs as string[] | undefined) ?? []).slice(-5).join(' | ')}`,
    );
  }
  const ret = Buffer.from(returnData.data[0] as string, 'base64');
  if (ret.length < 8)
    throw new Error(`LayerZero quote returned ${ret.length} bytes, expected >= 8`);
  return ret.readBigUInt64LE(0);
}
