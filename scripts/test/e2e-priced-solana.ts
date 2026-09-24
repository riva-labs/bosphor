/**
 * e2e-priced-solana.ts
 *
 * HITL end-to-end verification of the M4 priced payment round-trip on the
 * Solana devnet origin, the Solana mirror of e2e-priced.ts (EVM). Not run in CI;
 * needs live infra: the devnet adapter, a relayer with /quote + /blob, the
 * self-DVN forward leg (Solana -> Sui), and the solana-return worker (Sui ->
 * Solana lz_receive, which releases the escrow).
 *
 * Phase A (release): SDK priceQuote -> submitPaid (escrow + LZ fee) -> upload ->
 *   awaitProof. Asserts the per-intent escrow vault was Pending with the quoted
 *   amount, then CLOSED by the proof-driven lz_receive, and that the closing
 *   transaction credited the recorded beneficiary the whole vault (escrow + rent).
 *   A proof that lands through the owner-gated confirm_execution fallback does
 *   NOT release, so it fails this phase loudly instead of passing.
 *
 * Phase B (refund on timeout): submit a priced intent with a short deadline and
 *   never deliver its bytes, so the relayer cannot store it (no bytes, and the
 *   blob was never uploaded to Walrus, so byte recovery cannot fetch it either).
 *   Wait until the CHAIN clock passes the deadline, call refund_escrow, and assert
 *   the payer was credited the whole vault minus the refund tx fee and the vault
 *   is closed.
 *
 * RPC discipline: the public devnet RPC rate-limits hard, so this script is
 * HTTP-only (no websocket subscriptions; confirmation polls
 * getSignatureStatuses) and every call goes through a 429-aware exponential
 * backoff (scripts/solana/src/rpc.ts). It refuses to run unless the RPC's genesis
 * hash is devnet's.
 *
 * Usage:
 *   (cd scripts/solana && npm install)   # Solana deps live in that package
 *   BOSPHOR_ENV_FILE=.env.testnet-e2e npm run test:e2e:priced:solana
 *
 * Required env (in BOSPHOR_ENV_FILE): RELAYER_URL, SOLANA_RPC_URL (devnet),
 *   SOLANA_KEYPAIR (funded devnet payer; defaults to ~/.config/solana/bosphor-devnet.json)
 * Optional: NATIVE_FEE (lamports, default 3000000), WALRUS_STORE_EPOCHS (5),
 *   PROOF_TIMEOUT_MIN (30), REFUND_DEADLINE_S (90), SKIP_PHASE_A=1, SKIP_PHASE_B=1
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { BosphorSolanaClient } from "../../sdk/src/solana/client.ts";
import { defaultComputeBlob } from "../../sdk/src/blob.ts";
import { connection, payer, SUI_EID } from "../solana/src/config.ts";
import { assertDevnet, base58, createHttpSolanaChain } from "../solana/src/http-chain.ts";
import { pollUntil, sleep, withBackoff } from "../solana/src/rpc.ts";
import {
  ESCROW_PENDING,
  balanceDelta,
  expectedCloseCredit,
  refundAllowed,
} from "../solana/src/escrow.ts";

// scripts/solana/src/config.ts loads BOSPHOR_ENV_FILE at import time (imports
// are hoisted, and none of them touches the network), so these checks still run
// before any RPC. Require the file explicitly, and require the network keys to be
// IN it, so a missing key can never be filled from a repo-root .env that points
// at mainnet.
const ENV_FILE = process.env.BOSPHOR_ENV_FILE;
if (!ENV_FILE) {
  console.error("Set BOSPHOR_ENV_FILE to the devnet/testnet env file (e.g. .env.testnet-e2e)");
  process.exit(1);
}
const fileEnv = parse(readFileSync(resolve(ENV_FILE)));
for (const key of ["RELAYER_URL", "SOLANA_RPC_URL"]) {
  if (!fileEnv[key]) {
    console.error(`${key} must be set in ${ENV_FILE}`);
    process.exit(1);
  }
}

type Hex = `0x${string}`;

// From the file itself: a RELAYER_URL already exported in the shell must not win.
const RELAYER_URL = fileEnv.RELAYER_URL!;
const NATIVE_FEE = BigInt(process.env.NATIVE_FEE ?? "3000000");
const STORAGE_EPOCHS = Number(process.env.WALRUS_STORE_EPOCHS) || 5;
const PROOF_TIMEOUT_MS = (Number(process.env.PROOF_TIMEOUT_MIN) || 30) * 60_000;
const REFUND_DEADLINE_S = Number(process.env.REFUND_DEADLINE_S) || 90;

const conn = connection();
const wallet = payer();
const chain = createHttpSolanaChain(conn, wallet);
const bosphor = new BosphorSolanaClient({
  chain,
  relayerUrl: RELAYER_URL,
  dstEid: SUI_EID,
  nativeFee: NATIVE_FEE,
  defaultEpochs: STORAGE_EPOCHS,
  computeBlob: defaultComputeBlob,
});

function uniqueData(tag: string): Uint8Array {
  return new TextEncoder().encode(`bosphor-m4-priced-solana-${tag}-${Date.now()}-${Math.random()}`);
}

/** Read the freshly opened escrow and assert it is Pending, funded, and ours. */
async function openedEscrow(intentId: Hex, quotedEscrow: bigint) {
  const e = await chain.readEscrow(intentId);
  if (!e) throw new Error(`escrow vault for ${intentId} does not exist after submit`);
  console.log(
    `  escrow ${e.address.toBase58()}: status ${e.vault.status}, amount ${e.vault.amount}, ` +
      `vault lamports ${e.lamports}, beneficiary ${base58(e.vault.beneficiary)}`,
  );
  if (e.vault.status !== ESCROW_PENDING) throw new Error("escrow did not open Pending");
  if (e.vault.amount !== quotedEscrow) {
    throw new Error(`escrow amount ${e.vault.amount} != quoted ${quotedEscrow}`);
  }
  if (base58(e.vault.payer) !== wallet.publicKey.toBase58()) throw new Error("escrow payer is not the submitter");
  return e;
}

async function phaseRelease(): Promise<void> {
  console.log("\n=== Phase A: priced store -> proof -> escrow release ===");
  const data = uniqueData("release");
  const encoded = await bosphor.encode(data, { epochs: STORAGE_EPOCHS });
  const quote = await bosphor.priceQuote(encoded);
  console.log(`  quote: escrow ${quote.escrowNative} lamports ($${quote.breakdown.escrowUsd.toFixed(4)}), forward fee ${quote.forwardNative}`);
  const { intentId, txHash } = await bosphor.submitPaid(encoded, quote);
  console.log(`  intentId: ${intentId}\n  submit tx: ${txHash}`);
  const opened = await openedEscrow(intentId, quote.escrowNative);

  // The relayer only accepts bytes once it knows the commitment (after the
  // forward leg lands on Sui via the self-DVN), so retry 404s with backoff.
  const uploaded = await pollUntil(
    async () => {
      try {
        await bosphor.upload(intentId, data);
        return true;
      } catch (err) {
        if ((err as { status?: number }).status === 404) return null;
        throw err;
      }
    },
    {
      timeoutMs: PROOF_TIMEOUT_MS,
      pollMs: 15_000,
      onTick: (ms) => console.log(`  waiting for the relayer to learn the intent (${Math.round(ms / 1000)}s)...`),
    },
  );
  if (!uploaded) throw new Error("relayer never accepted the blob (forward leg not delivered?)");
  console.log("  blob uploaded; awaiting the return proof (lz_receive releases the escrow)...");

  const proof = await bosphor.awaitProof(intentId, { timeoutMs: PROOF_TIMEOUT_MS, pollMs: 15_000 });
  console.log(`  proof: blobId ${proof.blobId}, endEpoch ${proof.endEpoch}`);
  if (proof.blobId.toLowerCase() !== encoded.blobId.toLowerCase()) throw new Error("proof blob id != committed blob id");

  const after = await chain.readEscrow(intentId);
  if (after) {
    throw new Error(
      `intent executed but escrow still open (status ${after.vault.status}): the proof came through the ` +
        "non-releasing confirm_execution fallback, not lz_receive",
    );
  }
  const closeSig = await chain.latestSignature(opened.address);
  if (!closeSig) throw new Error("no transaction found for the escrow vault");
  const { meta, keys } = await chain.txMeta(closeSig);
  // The vault closes on release AND on refund, and with the default keypair the
  // payer and beneficiary are the same key, so balances alone cannot tell them
  // apart. Require the closing tx to be the LayerZero delivery.
  if (!(meta.logMessages ?? []).some((l: string) => l.includes("Instruction: LzReceive"))) {
    throw new Error(`escrow closed by ${closeSig}, which is not an lz_receive (refund, not a release?)`);
  }
  const beneficiary = base58(opened.vault.beneficiary);
  const idx = keys.indexOf(beneficiary);
  if (idx === -1) throw new Error(`beneficiary ${beneficiary} not in release tx ${closeSig}`);
  const credited = balanceDelta(meta, idx);
  const expected = expectedCloseCredit(opened.lamports, meta.fee, idx === 0);
  console.log(`  release tx ${closeSig}: beneficiary +${credited} lamports (expected ${expected})`);
  if (credited !== expected) throw new Error("beneficiary was not credited the whole escrow vault");
  console.log("  [OK] proof released the escrow to the relayer beneficiary");
}

async function phaseRefund(): Promise<void> {
  console.log("\n=== Phase B: refund on timeout (bytes never delivered) ===");
  const deadline = (await chain.chainTime()) + BigInt(REFUND_DEADLINE_S);
  const encoded = await bosphor.encode(uniqueData("refund"), { epochs: STORAGE_EPOCHS, deadline });
  const quote = await bosphor.priceQuote(encoded);
  const { intentId, txHash } = await bosphor.submitPaid(encoded, quote);
  console.log(`  submitted (never uploaded): ${intentId}\n  submit tx: ${txHash}\n  deadline: ${deadline}`);
  const opened = await openedEscrow(intentId, quote.escrowNative);

  console.log("  waiting for the chain clock to pass the deadline...");
  const passed = await pollUntil(
    async () => ((await chain.chainTime()) > deadline ? true : null),
    { timeoutMs: (REFUND_DEADLINE_S + 300) * 1000, pollMs: 10_000 },
  );
  if (!passed) throw new Error("chain clock did not pass the deadline in time");
  await sleep(2_000); // one more slot of margin for the program's Clock sysvar

  const pending = await chain.readEscrow(intentId);
  if (!pending) throw new Error("escrow closed before refund: the relayer should have skipped this intent");
  if (!refundAllowed(pending.vault.status, await chain.chainTime(), pending.vault.deadline)) {
    throw new Error(`refund not allowed yet (status ${pending.vault.status})`);
  }

  const sig = await chain.refund(intentId, pending.vault.payer);
  const { meta, keys } = await chain.txMeta(sig);
  const idx = keys.indexOf(wallet.publicKey.toBase58());
  const credited = balanceDelta(meta, idx);
  const expected = expectedCloseCredit(opened.lamports, meta.fee, idx === 0);
  console.log(`  refund tx ${sig}: payer ${credited >= 0n ? "+" : ""}${credited} lamports (expected ${expected}, fee ${meta.fee})`);
  if (credited !== expected) throw new Error("refund did not credit the payer the whole escrow vault");
  if (await chain.readEscrow(intentId)) throw new Error("escrow vault still open after refund");
  console.log("  [OK] deadline refund returned the escrow (and vault rent) to the payer");
}

async function main(): Promise<void> {
  console.log("=== Bosphor M4 priced e2e (Solana devnet) ===");
  await assertDevnet(conn);
  const balance = await withBackoff(() => conn.getBalance(wallet.publicKey));
  console.log(`  payer:   ${wallet.publicKey.toBase58()} (${balance} lamports)`);
  console.log(`  relayer: ${RELAYER_URL}`);
  if (process.env.SKIP_PHASE_A !== "1") await phaseRelease();
  if (process.env.SKIP_PHASE_B !== "1") await phaseRefund();
  console.log("\n=== Solana priced e2e complete ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
