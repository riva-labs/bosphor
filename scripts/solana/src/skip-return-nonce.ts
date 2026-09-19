/**
 * Clear a backlog of unrecoverable inbound nonces on the Sui->Solana return
 * channel so the endpoint's inbound frontier advances and later (recoverable)
 * return proofs deliver, releasing their escrows. Same class of wedge as the EVM
 * return gap: the worker fell far behind while down, old nonces' packets are past
 * the queryable event window, and LZ's gapless-order rule blocks every later
 * nonce with InvalidNonce.
 *
 * `skip` needs the nonce's payload_hash PDA to exist, so we `initVerify` it first
 * (allocates the PDA from receiver/srcEid/sender/nonce, no packet payload needed),
 * then `skip`. Both go in one tx; skip only advances by one, so we chain nonces.
 * Dry-run (reads only) unless RUN=1.
 *
 *   npx tsx src/skip-return-nonce.ts <toNonce>          # dry-run
 *   RUN=1 npx tsx src/skip-return-nonce.ts <toNonce>    # initVerify+skip frontier+1..toNonce
 */
import { Connection, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { EndpointProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import { connection, payer, storePda, ENDPOINT_ID, SUI_TESTNET_EID } from "./config.ts";

const SUI_OAPP_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID!;
const RUN = process.env.RUN === "1";
const PAIRS_PER_TX = Number(process.env.PAIRS_PER_TX ?? "6");

function suiOappBytes(): Uint8Array {
  const h = SUI_OAPP_PACKAGE_ID.startsWith("0x") ? SUI_OAPP_PACKAGE_ID.slice(2) : SUI_OAPP_PACKAGE_ID;
  return Uint8Array.from(Buffer.from(h.padStart(64, "0"), "hex"));
}

function normalizeIx(raw: {
  programId: { toBase58(): string };
  keys: { pubkey: { toBase58(): string }; isSigner: boolean; isWritable: boolean }[];
  data: Uint8Array;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId.toBase58()),
    keys: raw.keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey.toBase58()),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(raw.data),
  });
}

async function main() {
  if (!SUI_OAPP_PACKAGE_ID) throw new Error("set SUI_LZ_PACKAGE_ID (Sui OApp sender)");
  const to = BigInt(process.argv[2] ?? "");
  if (!to) throw new Error("usage: skip-return-nonce <toNonce>");

  const conn: Connection = connection();
  const admin = payer();
  const store = storePda();
  const senderBytes = suiOappBytes();
  const senderPk = new PublicKey(senderBytes);
  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);

  const nonce = await endpoint.getNonce(conn, store, SUI_TESTNET_EID, senderBytes);
  if (!nonce) throw new Error("no Nonce account for this pathway");
  const frontier = BigInt(nonce.inboundNonce.toString());
  console.log(`store ${store.toBase58()} srcEid ${SUI_TESTNET_EID}`);
  console.log(`inbound frontier ${frontier}; clearing ${frontier + 1n}..${to} (${to - frontier} nonces); RUN=${RUN} pairs/tx=${PAIRS_PER_TX}`);
  if (to <= frontier) {
    console.log("nothing to clear (to <= frontier)");
    return;
  }
  if (!RUN) {
    console.log(`[dry] would initVerify+skip ${to - frontier} nonces`);
    return;
  }

  const SLEEP_MS = Number(process.env.SLEEP_MS ?? "1200");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const is429 = (e: unknown) => /429|rate limit|Too Many/i.test(String((e as Error)?.message));

  // HTTP-only retry wrapper: the public devnet RPC 429s aggressively, and its
  // confirmation websocket 429s even harder, so we never use ws.
  async function rpc<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (is429(e) && i < 12) { await sleep(2000 * (i + 1)); continue; }
        throw e;
      }
    }
  }
  // Send + confirm over HTTP only (poll getSignatureStatus, no ws subscription).
  async function sendPolled(tx: Transaction): Promise<string> {
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await rpc(() => conn.getLatestBlockhash("confirmed"))).blockhash;
    tx.sign(admin);
    const sig = await rpc(() => conn.sendRawTransaction(tx.serialize(), { skipPreflight: true }));
    for (let i = 0; i < 40; i++) {
      await sleep(1000);
      const st = await rpc(() => conn.getSignatureStatus(sig));
      const cs = st.value?.confirmationStatus;
      if (st.value?.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(st.value.err)}`);
      if (cs === "confirmed" || cs === "finalized") return sig;
    }
    throw new Error(`tx ${sig} not confirmed in time`);
  }

  // Batch K consecutive skips per tx (gaps run consecutive when the worker was
  // down for a stretch), which slashes RPC calls vs one tx per nonce. Re-read the
  // frontier after each tx: it cascades through any already-delivered run for
  // free. On a tx failure at a gap/delivered boundary, shrink the batch and let
  // the re-read resync. Paced + 429-resilient for the public devnet RPC.
  let cur = frontier;
  let rounds = 0;
  let batch = Math.max(1, PAIRS_PER_TX);
  while (cur < to) {
    const k = Number(to - cur < BigInt(batch) ? to - cur : BigInt(batch));
    const tx = new Transaction();
    for (let i = 1; i <= k; i++) {
      const n = cur + BigInt(i);
      const initRaw = await rpc(() => endpoint.initVerify(
        conn as never, admin.publicKey as never, senderPk as never, store as never,
        SUI_TESTNET_EID, n.toString(),
      ));
      const skipRaw = await endpoint.skip(admin.publicKey, senderPk, store, SUI_TESTNET_EID, n.toString());
      if (initRaw) tx.add(normalizeIx(initRaw as never));
      if (skipRaw) tx.add(normalizeIx(skipRaw as never));
    }
    try {
      await sendPolled(tx);
      rounds += k;
      batch = Math.max(1, PAIRS_PER_TX); // recover batch size after a success
    } catch (e) {
      if (batch > 1) { batch = Math.max(1, Math.floor(batch / 2)); continue; } // boundary/oversize: shrink
      // batch==1 and still failing: likely hit a delivered nonce; let re-read resync
    }
    await sleep(SLEEP_MS);
    const nn = await rpc(() => endpoint.getNonce(conn, store, SUI_TESTNET_EID, senderBytes));
    const next = nn ? BigInt(nn.inboundNonce.toString()) : cur;
    if (next <= cur) {
      console.log(`  frontier stuck at ${cur}; stopping`);
      break;
    }
    console.log(`  frontier -> ${next} (${rounds} skips)`);
    cur = next;
  }

  const after = await endpoint.getNonce(conn, store, SUI_TESTNET_EID, senderBytes);
  console.log(`cleared ~${rounds} gap nonces; new inbound frontier ${after ? after.inboundNonce.toString() : "?"}`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
