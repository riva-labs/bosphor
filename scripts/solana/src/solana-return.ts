/**
 * Return-path worker: Sui testnet (EID 40378) -> Solana devnet (EID 40168).
 *
 * Self-operated, mirrors the proven EVM sibling /home/arb/bosphor-dvn/src/evm-return.ts.
 * On the return leg we are BOTH the DVN and the executor: the same keypair that
 * is registered as the required receive-ULN DVN (see set-receive-dvn.ts) signs
 * the ULN `verify`, then we permissionlessly `commitVerification`, then run the
 * adapter's `lz_receive` which releases the on-chain escrow:
 *   1. UlnProgram.Uln.initVerify(dvn, packetBytes)   // create Confirmations PDA (if absent)
 *   2. UlnProgram.Uln.verify(dvn, packetBytes, conf)  // our DVN attests (dvn signs)
 *   3. UlnProgram.Uln.commitVerification(conn, packetBytes, endpoint)  // finalize -> executable
 *   4. bosphor-adapter lz_receive(params)             // execute -> escrow released, intent.executed
 *
 * Source of truth for new return packets is the Sui endpoint's PacketSentEvent
 * (messaging_channel::PacketSentEvent). Its `encoded_packet` is a standard
 * PacketV1 payload, so lz-packet.ts::decodePacket handles it directly. No LZ
 * infra is involved, matching the self-operated design.
 *
 * SAFETY: without RUN=1 this is DRY-RUN only. It simulates the initVerify+verify
 * tx (read-only) and prints the resolved lz_receive account metas (proving the
 * account assembly), but NEVER broadcasts. RUN=1 enables the real send path.
 *
 * Usage:
 *   RETURN_MODE=one tsx src/solana-return.ts <sui-tx-digest>   one packet (DRY unless RUN=1)
 *   RETURN_MODE=loop tsx src/solana-return.ts                  continuous worker
 *   npm run solana-return                                       (defaults: loop unless argv[2])
 *
 * Env (all optional unless noted):
 *   RUN=1                    enable real broadcast (otherwise DRY-RUN)
 *   SUI_ENV_PATH             dotenv path for Sui endpoint/package ids (default ../../relayer/.env.testnet)
 *   SUI_ENDPOINT_V2 | SUI_LZ_ENDPOINT_V2   Sui endpoint id (for the event type)
 *   SUI_LZ_PACKAGE_ID        Sui OApp package id (packet sender bytes32)
 *   SUI_JSONRPC_URL          override the Sui JSON-RPC (default publicnode)
 *   SUI_RELAYER_ADDR         the Sui sender to filter queryEvents by
 *   RETURN_CONFIRMATIONS     DVN confirmations to attest (default 1)
 *   RETURN_MIN_NONCE         skip return packets below this nonce in loop mode
 *   RETURN_POLL_MS           loop poll interval (default 15000)
 *   SOLANA_RPC_URL, SOLANA_KEYPAIR   see config.ts
 */

import { resolve } from "node:path";
import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import * as dotenv from "dotenv";
import {
  BOSPHOR_PROGRAM_ID,
  ENDPOINT_ID,
  SOLANA_DEVNET_EID,
  SUI_TESTNET_EID,
  ULN_ID,
  connection,
  lzReceiveTypesPda,
  payer,
  storePda,
} from "./config.ts";
import { decodePacket, type LzPacket } from "./lz-packet.ts";

// Anchor instruction discriminators for the bosphor-adapter program, pinned in
// /home/arb/bosphor/sdk/src/solana/program.ts (KNOWN_DISCRIMINATORS.instruction).
// Hardcoded here to avoid a cross-package import into the published SDK.
const DISC_LZ_RECEIVE = "08b3786d2176bd50";
const DISC_LZ_RECEIVE_TYPES = "dd11f69ff8801f60";

// Load Sui endpoint/package ids from the relayer testnet env by default. These
// are operational values (not secrets); SUI_ENV_PATH overrides the location, and
// explicit SUI_ENDPOINT_V2 / SUI_LZ_PACKAGE_ID env vars take precedence.
const SUI_ENV_PATH =
  process.env.SUI_ENV_PATH ??
  resolve(import.meta.dirname, "../../../relayer/.env.testnet");
dotenv.config({ path: SUI_ENV_PATH });

const RUN = process.env.RUN === "1";
const RETURN_CONF = BigInt(process.env.RETURN_CONFIRMATIONS ?? "1");
const POLL_MS = Number(process.env.RETURN_POLL_MS ?? 15_000);
const MIN_NONCE = BigInt(process.env.RETURN_MIN_NONCE ?? "0");

const SUI_ENDPOINT_V2 =
  process.env.SUI_ENDPOINT_V2 ?? process.env.SUI_LZ_ENDPOINT_V2;
const SUI_OAPP_PACKAGE_ID = process.env.SUI_LZ_PACKAGE_ID;
if (!SUI_ENDPOINT_V2) {
  throw new Error(
    "missing SUI_ENDPOINT_V2 / SUI_LZ_ENDPOINT_V2 (set it or point SUI_ENV_PATH at relayer/.env.testnet)",
  );
}
if (!SUI_OAPP_PACKAGE_ID) {
  throw new Error(
    "missing SUI_LZ_PACKAGE_ID (set it or point SUI_ENV_PATH at relayer/.env.testnet)",
  );
}

const PACKET_SENT_EVENT = `${SUI_ENDPOINT_V2}::messaging_channel::PacketSentEvent`;

// The official testnet fullnode rate-limits JSON-RPC hard and often returns
// empty bodies; publicnode is a reliable free alternative. Override with
// SUI_JSONRPC_URL.
const SUI_JSONRPC =
  process.env.SUI_JSONRPC_URL ?? "https://sui-testnet-rpc.publicnode.com";
// The Sui relayer that sends the return proof. Filtering queryEvents by this
// sender returns a small, recent set the public RPCs serve reliably.
const SUI_RELAYER_ADDR =
  process.env.SUI_RELAYER_ADDR ??
  "0xa11070a3877b77355a0afbc402559cae7501c666819f05491f0337016c219366";

/** Left-pad a 0x hex value to a 32-byte (64 hex char) lowercase bytes32, no 0x. */
function toBytes32Hex(hex: string): string {
  const h = (hex.startsWith("0x") ? hex.slice(2) : hex).toLowerCase();
  if (h.length > 64) throw new Error(`value exceeds 32 bytes: ${hex}`);
  return h.padStart(64, "0");
}

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(h, "hex"));
}

// The packet sender on the return leg is the Sui OApp package id as bytes32.
const SUI_OAPP_SENDER_B32 = toBytes32Hex(SUI_OAPP_PACKAGE_ID);
// The packet receiver on the return leg is our Solana Store PDA as bytes32.
const SOLANA_STORE_B32 = Buffer.from(storePda().toBuffer()).toString("hex");

/** Is this a return packet on our pathway (Sui OApp -> our Store PDA on Solana)? */
function isOurReturn(pkt: LzPacket): boolean {
  return (
    pkt.srcEid === SUI_TESTNET_EID && // 40378 (Sui)
    pkt.dstEid === SOLANA_DEVNET_EID && // 40168 (Solana devnet)
    toBytes32Hex(pkt.sender) === SUI_OAPP_SENDER_B32 &&
    toBytes32Hex(pkt.receiver) === SOLANA_STORE_B32
  );
}

/**
 * The LZ SDK bundles its own @solana/web3.js copy, so a TransactionInstruction it
 * returns carries PublicKey objects from that copy. Re-wrap every pubkey through
 * OUR PublicKey so Transaction serialization never mixes two PublicKey classes
 * (the known cross-instance footgun; see submit-intent.ts ~L132-145).
 */
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

/**
 * Serialize oapp::LzReceiveParams with borsh (manual; matches the Rust struct in
 * LayerZero-v2/.../libs/oapp/src/lib.rs):
 *   src_eid: u32 LE
 *   sender:  [u8; 32]
 *   nonce:   u64 LE
 *   guid:    [u8; 32]
 *   message: Vec<u8>  (u32 LE len ++ bytes)
 *   extra_data: Vec<u8> (u32 LE len ++ bytes)
 */
function serializeLzReceiveParams(p: {
  srcEid: number;
  sender: Uint8Array; // 32
  nonce: bigint;
  guid: Uint8Array; // 32
  message: Uint8Array;
  extraData: Uint8Array;
}): Buffer {
  if (p.sender.length !== 32) throw new Error("sender must be 32 bytes");
  if (p.guid.length !== 32) throw new Error("guid must be 32 bytes");
  const head = Buffer.alloc(4 + 32 + 8 + 32);
  head.writeUInt32LE(p.srcEid, 0);
  Buffer.from(p.sender).copy(head, 4);
  head.writeBigUInt64LE(p.nonce, 36);
  Buffer.from(p.guid).copy(head, 44);
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32LE(p.message.length, 0);
  const extraLen = Buffer.alloc(4);
  extraLen.writeUInt32LE(p.extraData.length, 0);
  return Buffer.concat([
    head,
    msgLen,
    Buffer.from(p.message),
    extraLen,
    Buffer.from(p.extraData),
  ]);
}

interface LzAccountMeta {
  pubkey: PublicKey;
  isSigner: boolean;
  isWritable: boolean;
}

/**
 * Decode the program's `Result<Vec<LzAccount>>` return value. Anchor serializes
 * the return of lz_receive_types via set_return_data as borsh:
 *   u32 LE count ++ [pubkey(32) ++ is_signer(u8) ++ is_writable(u8)] * count
 * (LzAccount is defined in oapp::endpoint_cpi, fields: pubkey, is_signer, is_writable.)
 */
function decodeLzAccounts(returnDataB64: string): LzAccountMeta[] {
  const buf = Buffer.from(returnDataB64, "base64");
  const count = buf.readUInt32LE(0);
  const metas: LzAccountMeta[] = [];
  let off = 4;
  for (let i = 0; i < count; i++) {
    const pubkey = new PublicKey(buf.subarray(off, off + 32));
    const isSigner = buf[off + 32] === 1;
    const isWritable = buf[off + 33] === 1;
    metas.push({ pubkey, isSigner, isWritable });
    off += 34;
  }
  return metas;
}

/**
 * Resolve the ordered lz_receive account metas by simulating the program's
 * lz_receive_types view instruction. This mirrors getLzReceiveAccountsFromTypesV1,
 * which is NOT exported from the SDK root, so we build it directly.
 *
 * lz_receive_types ix accounts (from LzReceiveTypes Accounts struct order in
 * contracts/solana/programs/bosphor-adapter/src/instructions/lz_receive_types.rs):
 *   0 - store                      (PDA, readonly)
 *   1 - lz_receive_types_accounts  (PDA, readonly)
 *
 * Returned Vec<LzAccount> layout (cited from lz_receive_types.rs handler):
 *   0 - payer (executor)  [signer, writable]   <- we substitute our worker pubkey
 *   1 - peer              [readonly]
 *   2 - store             [readonly]
 *   3 - intent            [writable]
 *   4 - escrow            [writable]
 *   5 - beneficiary       [writable]
 *   6.. - endpoint accounts for `clear` (get_accounts_for_clear)
 */
async function resolveLzReceiveAccounts(
  conn: ReturnType<typeof connection>,
  workerPubkey: PublicKey,
  params: Buffer,
): Promise<LzAccountMeta[]> {
  const store = storePda();
  const typesIx = new TransactionInstruction({
    programId: BOSPHOR_PROGRAM_ID,
    keys: [
      { pubkey: store, isSigner: false, isWritable: false },
      { pubkey: lzReceiveTypesPda(store), isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([Buffer.from(DISC_LZ_RECEIVE_TYPES, "hex"), params]),
  });

  const tx = new Transaction().add(typesIx);
  tx.feePayer = workerPubkey;
  tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  const sim = await conn.simulateTransaction(tx);
  if (sim.value.err) {
    throw new Error(
      `lz_receive_types simulate failed: ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).join("\n")}`,
    );
  }
  const rd = sim.value.returnData;
  if (!rd?.data?.[0]) {
    throw new Error(
      `lz_receive_types returned no return-data\n${(sim.value.logs ?? []).join("\n")}`,
    );
  }
  const metas = decodeLzAccounts(rd.data[0]);
  // Substitute our worker keypair into the signer/payer slot (index 0). The
  // program returns Pubkey::default() there as a placeholder for the executor.
  if (metas.length > 0) {
    metas[0] = { pubkey: workerPubkey, isSigner: true, isWritable: true };
  }
  return metas;
}

/** Extract a useful error string, including Solana simulation logs when present. */
function errText(e: unknown): string {
  const msg = String((e as Error)?.message ?? e).split("\n")[0];
  const logs = (e as { logs?: string[] })?.logs;
  return logs?.length ? `${msg}\n     ${logs.join("\n     ")}` : msg;
}

/** Raw PacketV1 bytes = header(81) ++ guid(32) ++ message. Derived from the packet. */
function packetBytes(pkt: LzPacket): Uint8Array {
  return Buffer.concat([
    Buffer.from(hexToBytes(pkt.header)),
    Buffer.from(hexToBytes(pkt.guid)),
    Buffer.from(hexToBytes(pkt.message)),
  ]);
}

/** verify -> commit -> lz_receive for one return packet. Idempotent + revert-tolerant. */
async function deliver(pkt: LzPacket): Promise<"sent" | "skipped" | "dry"> {
  const conn = connection();
  const worker = payer();
  const uln = new UlnProgram.Uln(ULN_ID);
  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);
  const bytes = packetBytes(pkt);

  // Build lz_receive params once (used both for account resolution and the ix).
  const params = serializeLzReceiveParams({
    srcEid: SUI_TESTNET_EID,
    sender: hexToBytes(pkt.sender),
    nonce: pkt.nonce,
    guid: hexToBytes(pkt.guid),
    message: hexToBytes(pkt.message),
    extraData: new Uint8Array(0),
  });

  // 0) endpoint initVerify: allocates the endpoint's payload_hash PDA (keyed by
  //    receiver/srcEid/sender/nonce). commitVerification's endpoint Verify CPI and
  //    lz_receive's Clear CPI both require it to already exist. Idempotent (null if
  //    present). sender = the Sui OApp bytes32 as a pubkey; receiver = our Store.
  let epInitVerifyIx: TransactionInstruction | null = null;
  try {
    const raw = await endpoint.initVerify(
      conn as never,
      worker.publicKey as never,
      new PublicKey(hexToBytes(pkt.sender)) as never,
      storePda() as never,
      SUI_TESTNET_EID,
      pkt.nonce.toString(),
    );
    epInitVerifyIx = raw ? normalizeIx(raw as never) : null;
  } catch (e) {
    console.log(`  endpoint.initVerify build skipped (${errText(e)})`);
  }

  // 1) uln initVerify: creates the ULN Confirmations PDA if absent (idempotent,
  //    returns null when present). payer==dvn==our worker.
  let initVerifyIx: TransactionInstruction | null = null;
  try {
    const raw = await uln.initVerify(
      conn as never,
      worker.publicKey as never,
      worker.publicKey as never,
      bytes,
    );
    initVerifyIx = raw ? normalizeIx(raw as never) : null;
  } catch (e) {
    console.log(`  uln.initVerify build skipped (${errText(e)})`);
  }

  // 2) verify (our DVN attests; the dvn keypair is the sole signer). RETURN_CONF
  //    is a bigint; the SDK wants number|string, so pass it as a decimal string.
  const verifyIx = normalizeIx(
    uln.verify(worker.publicKey as never, bytes, RETURN_CONF.toString()) as never,
  );

  // Resolve the lz_receive account metas up front so dry-run can print them and
  // prove the account assembly works. This is a read-only view simulation.
  let lzReceiveMetas: LzAccountMeta[] | null = null;
  try {
    lzReceiveMetas = await resolveLzReceiveAccounts(conn, worker.publicKey, params);
  } catch (e) {
    console.log(
      `  lz_receive_types resolve failed (${String((e as Error).message).split("\n")[0]})`,
    );
  }

  if (!RUN) {
    // DRY RUN: simulate initVerify+verify (read-only) and print the resolved
    // lz_receive account metas. Nothing is broadcast.
    const tx = new Transaction();
    if (epInitVerifyIx) tx.add(epInitVerifyIx);
    if (initVerifyIx) tx.add(initVerifyIx);
    tx.add(verifyIx);
    tx.feePayer = worker.publicKey;
    try {
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const sim = await conn.simulateTransaction(tx);
      if (sim.value.err) {
        console.log(
          `  [dry] nonce ${pkt.nonce} verify simulate FAILED: ${JSON.stringify(sim.value.err)}`,
        );
        console.log("   " + (sim.value.logs ?? []).join("\n   "));
      } else {
        console.log(
          `  [dry] nonce ${pkt.nonce} initVerify+verify simulate OK. Set RUN=1 to deliver.`,
        );
      }
    } catch (e) {
      console.log(
        `  [dry] nonce ${pkt.nonce} verify simulate error: ${String((e as Error).message).split("\n")[0]}`,
      );
    }
    if (lzReceiveMetas) {
      console.log(`  [dry] resolved ${lzReceiveMetas.length} lz_receive accounts:`);
      lzReceiveMetas.forEach((m, i) => {
        console.log(
          `    [${i}] ${m.pubkey.toBase58()} ${m.isSigner ? "S" : "-"}${m.isWritable ? "W" : "-"}`,
        );
      });
    }
    return "dry";
  }

  // --- REAL SEND PATH (RUN=1). Each step is revert-tolerant/idempotent. ---

  // 1+2) initVerify + verify in one tx (signer = worker keypair).
  try {
    const tx = new Transaction();
    if (epInitVerifyIx) tx.add(epInitVerifyIx);
    if (initVerifyIx) tx.add(initVerifyIx);
    tx.add(verifyIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [worker], {
      commitment: "confirmed",
    });
    console.log(`  verify   ${sig}`);
  } catch (e) {
    console.log(
      `  verify   skipped (${String((e as Error).message).split("\n")[0]})`,
    );
  }

  // 3) commitVerification (permissionless finalize; reads the on-chain receive config).
  try {
    const commitIx = normalizeIx(
      (await uln.commitVerification(conn as never, ENDPOINT_ID as never, bytes)) as never,
    );
    const sig = await sendAndConfirmTransaction(
      conn,
      new Transaction().add(commitIx),
      [worker],
      { commitment: "confirmed" },
    );
    console.log(`  commit   ${sig}`);
  } catch (e) {
    console.log(`  commit   skipped (${errText(e)})`);
  }

  // 4) lz_receive -> escrow released, intent.executed = true.
  try {
    if (!lzReceiveMetas) {
      lzReceiveMetas = await resolveLzReceiveAccounts(conn, worker.publicKey, params);
    }
    const lzReceiveIx = new TransactionInstruction({
      programId: BOSPHOR_PROGRAM_ID,
      keys: lzReceiveMetas,
      data: Buffer.concat([Buffer.from(DISC_LZ_RECEIVE, "hex"), params]),
    });
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
      .add(lzReceiveIx);
    const sig = await sendAndConfirmTransaction(conn, tx, [worker], {
      commitment: "confirmed",
    });
    console.log(`  lzReceive ${sig} -> escrow released`);
    return "sent";
  } catch (e) {
    console.log(`  lzReceive skipped (${errText(e)})`);
    return "skipped";
  }
}

/**
 * Resilient Sui JSON-RPC call: retries on network errors, non-2xx, and empty /
 * non-JSON bodies (the public fullnode returns these under load).
 */
async function suiRpc(method: string, params: unknown[], attempts = 4): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(SUI_JSONRPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const text = await res.text();
      if (!res.ok || !text) throw new Error(`sui rpc ${res.status} (${text.length} bytes)`);
      const d = JSON.parse(text);
      if (d.error) throw new Error(`sui rpc error: ${JSON.stringify(d.error)}`);
      return d.result;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr;
}

function packetFromEvent(ev: any): LzPacket | null {
  const ep = ev?.parsedJson?.encoded_packet;
  if (!ep) return null;
  const hex = Array.isArray(ep) ? "0x" + Buffer.from(ep).toString("hex") : ep;
  try {
    return decodePacket(hex);
  } catch {
    return null;
  }
}

/** Pull recent PacketSentEvents (from our relayer's txs), newest first. */
async function querySuiPacketSent(limit = 15): Promise<LzPacket[]> {
  let result: any;
  for (let l = limit; l >= 2; l = Math.floor(l / 2)) {
    try {
      result = await suiRpc("suix_queryEvents", [{ Sender: SUI_RELAYER_ADDR }, null, l, true]);
      break;
    } catch (e: any) {
      if (!String(e?.message).includes("referenced transaction events")) throw e;
      // window includes an unresolvable tx; try a smaller (newer-only) window
    }
  }
  const out: LzPacket[] = [];
  for (const ev of result?.data ?? []) {
    if (ev.type !== PACKET_SENT_EVENT) continue;
    const pkt = packetFromEvent(ev);
    if (pkt && isOurReturn(pkt)) out.push(pkt);
  }
  return out;
}

/** Fetch the PacketSentEvent from a single Sui transaction digest. */
async function packetFromDigest(digest: string): Promise<LzPacket> {
  const result = await suiRpc("sui_getTransactionBlock", [digest, { showEvents: true }]);
  const ev = (result?.events ?? []).find((e: any) => e.type === PACKET_SENT_EVENT);
  const pkt = ev && packetFromEvent(ev);
  if (!pkt) throw new Error("no PacketSentEvent in tx");
  return pkt;
}

async function runOne(): Promise<void> {
  const digest = process.argv[2];
  if (!digest) throw new Error("usage: RETURN_MODE=one solana-return <sui-tx-digest>");
  const pkt = await packetFromDigest(digest);
  console.log(`return packet: nonce ${pkt.nonce}, guid ${pkt.guid}`);
  if (!isOurReturn(pkt)) {
    console.log("NOT our return pathway; aborting.", {
      srcEid: pkt.srcEid,
      dstEid: pkt.dstEid,
      sender: pkt.sender,
      receiver: pkt.receiver,
    });
    return;
  }
  await deliver(pkt);
}

async function runLoop(): Promise<void> {
  const worker = payer();
  console.log(
    `Solana return worker: Sui(${SUI_TESTNET_EID}) -> Solana devnet(${SOLANA_DEVNET_EID}); ` +
      `worker ${worker.publicKey.toBase58()}; store ${storePda().toBase58()}; RUN=${RUN}`,
  );
  const seen = new Set<string>();
  for (;;) {
    try {
      const packets = await querySuiPacketSent();
      for (const pkt of packets.reverse()) {
        if (seen.has(pkt.guid)) continue;
        if (pkt.nonce < MIN_NONCE) continue;
        console.log(`[return nonce ${pkt.nonce}] ${pkt.guid}`);
        const r = await deliver(pkt);
        if (r !== "skipped") seen.add(pkt.guid);
      }
    } catch (e) {
      console.error("tick error:", e);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

const mode = process.env.RETURN_MODE ?? (process.argv[2] ? "one" : "loop");
(mode === "one" ? runOne() : runLoop()).catch((e) => {
  console.error("solana-return failed:", e);
  process.exit(1);
});
