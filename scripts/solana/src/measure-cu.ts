/**
 * Compute-unit measurement for the Bosphor Solana adapter (M4 evidence c).
 *
 * READ-ONLY: nothing is signed or sent. It uses `simulateTransaction` with
 * `sigVerify: false` + `replaceRecentBlockhash: true`, so only a FUNDED PUBLIC
 * KEY is needed (the payer must hold enough lamports for the escrow + LZ fee for
 * the simulation to reach the program). Default target is devnet; it refuses to
 * run against any cluster whose genesis hash is not devnet's.
 *
 * Measures:
 *   1. submit_intent (priced: escrow + LZ endpoint `send` CPI), simulated.
 *   2. refund_escrow, simulated, when REFUND_INTENT_ID names an expired, still
 *      Pending escrow (e.g. the Phase B intent of the priced e2e).
 *   3. Any already-confirmed transactions in CU_SIGNATURES (comma-separated),
 *      e.g. lz_receive releases sent by the solana-return worker: reads
 *      meta.computeUnitsConsumed from getTransaction (read-only).
 *
 *   BOSPHOR_ENV_FILE=../../.env.testnet-e2e npm run measure-cu
 *   CU_SIGNATURES=<sig1>,<sig2> npm run measure-cu
 *
 * Env: SOLANA_RPC_URL (default devnet), SOLANA_KEYPAIR or CU_PAYER (base58
 * pubkey), NATIVE_FEE (default 3000000), ESCROW_AMOUNT (default 5000000).
 */

import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import { DEVNET_GENESIS_HASH, connection, escrowPda, payer } from "./config.ts";
import { withBackoff } from "./rpc.ts";
import { buildRefundEscrowIx, buildSubmitIntentTx, toBytes32 } from "./submit-intent-ix.ts";
import { decodeEscrowVault, encodeRefundEscrowData } from "./escrow.ts";

/** The per-transaction CU ceiling, so a simulation reports true usage, not a cap. */
const SIM_CU_LIMIT = 1_400_000;

interface CuRow {
  what: string;
  unitsConsumed: number | null;
  err: string | null;
  source: string;
}

async function simulate(
  conn: ReturnType<typeof connection>,
  feePayer: PublicKey,
  tx: Transaction,
): Promise<{ units: number | null; err: string | null; logs: string[] }> {
  const { blockhash } = await withBackoff(() => conn.getLatestBlockhash("confirmed"));
  const msg = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: tx.instructions,
  }).compileToV0Message();
  const res = await withBackoff(() =>
    conn.simulateTransaction(new VersionedTransaction(msg), {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
    }),
  );
  return {
    units: res.value.unitsConsumed ?? null,
    err: res.value.err ? JSON.stringify(res.value.err) : null,
    logs: res.value.logs ?? [],
  };
}

async function main(): Promise<void> {
  const conn = connection();
  const genesis = await withBackoff(() => conn.getGenesisHash());
  if (genesis !== DEVNET_GENESIS_HASH && process.env.CU_ALLOW_NON_DEVNET !== "1") {
    throw new Error(`refusing to run: RPC genesis ${genesis} is not Solana devnet`);
  }
  const feePayer = process.env.CU_PAYER ? new PublicKey(process.env.CU_PAYER) : payer().publicKey;
  const rows: CuRow[] = [];

  // 1. submit_intent, priced (escrow deposit + LZ send CPI).
  const built = await buildSubmitIntentTx(conn, {
    sender: feePayer,
    blobIdHex: "0x" + "a1".repeat(32),
    size: 1024,
    encodingType: 1,
    storageEpochs: 5,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nativeFee: BigInt(process.env.NATIVE_FEE ?? "3000000"),
    escrowAmount: BigInt(process.env.ESCROW_AMOUNT ?? "5000000"),
    computeUnitLimit: null,
  });
  const submitTx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: SIM_CU_LIMIT }))
    .add(...built.tx.instructions);
  const sim = await simulate(conn, feePayer, submitTx);
  if (sim.err) console.error("submit_intent simulation logs:\n  " + sim.logs.join("\n  "));
  rows.push({ what: "submit_intent (priced, incl. LZ send CPI)", unitsConsumed: sim.units, err: sim.err, source: "simulateTransaction" });

  // 2. refund_escrow on an expired Pending escrow, if one is named.
  const refundId = process.env.REFUND_INTENT_ID;
  if (refundId) {
    const id = toBytes32(refundId);
    const acct = await withBackoff(() => conn.getAccountInfo(escrowPda(id)));
    if (!acct) throw new Error(`no escrow vault for ${refundId} (already released or refunded?)`);
    const vault = decodeEscrowVault(new Uint8Array(acct.data));
    const ix = buildRefundEscrowIx(feePayer, new PublicKey(vault.payer), id, encodeRefundEscrowData(id));
    const r = await simulate(conn, feePayer, new Transaction().add(ix));
    rows.push({ what: "refund_escrow", unitsConsumed: r.units, err: r.err, source: "simulateTransaction" });
  }

  // 3. Confirmed transactions (e.g. lz_receive escrow releases), read-only.
  for (const sig of (process.env.CU_SIGNATURES ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const tx = await withBackoff(() =>
      conn.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }),
    );
    rows.push({
      what: `confirmed tx ${sig.slice(0, 12)}...`,
      unitsConsumed: tx?.meta?.computeUnitsConsumed ?? null,
      err: tx ? (tx.meta?.err ? JSON.stringify(tx.meta.err) : null) : "not found",
      source: "getTransaction meta",
    });
  }

  console.log(`RPC genesis ${genesis}; fee payer ${feePayer.toBase58()}\n`);
  console.log("| Instruction | Compute units | Error | Source |");
  console.log("|---|---:|---|---|");
  for (const r of rows) {
    console.log(`| ${r.what} | ${r.unitsConsumed ?? "n/a"} | ${r.err ?? "none"} | ${r.source} |`);
  }
  if (rows.some((r) => r.err)) process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
