/**
 * Register our self-operated DVN as the required DVN on the OApp's RECEIVE-ULN
 * config for src eid = Sui (40378), so a Sui->Solana return packet can be
 * verified by a keypair we control and the escrow-releasing `lz_receive` can run
 * (M4 #398). This is the Solana analogue of the EVM `set-evm-receive-uln` step:
 * the LZ-default Sui-testnet DVN is dead, so we self-verify.
 *
 * The receive LIBRARY for src 40378 is already ULN302 (set by `set-libraries`).
 * This only sets `required_dvns = [OUR_DVN]` in the receive config. The DVN is a
 * plain Ed25519 pubkey (the direct-signer model the Solana ULN allows): the same
 * keypair later signs the ULN `verify` in the return worker.
 *
 * Safe by default: builds the setConfig instruction and SIMULATES it (read-only).
 * Nothing is broadcast unless --apply is passed.
 *
 *   npm run set-receive-dvn            # simulate only
 *   npm run set-receive-dvn -- --apply # send the setConfig tx
 *
 * Env: SOLANA_KEYPAIR (admin/delegate, default devnet path), SOLANA_RPC_URL,
 *      SOLANA_DVN_PUBKEY (optional; defaults to the admin keypair's pubkey),
 *      SOLANA_RECEIVE_CONFIRMATIONS (optional, default 1).
 */

import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { EndpointProgram, UlnProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import {
  ENDPOINT_ID,
  SUI_TESTNET_EID,
  ULN_ID,
  connection,
  payer,
  storePda,
} from "./config.ts";

// LZ SetConfigType: EXECUTOR=1, SEND_ULN=2, RECEIVE_ULN=3.
const CONFIG_TYPE_RECEIVE_ULN = 3;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const conn = connection();
  const admin = payer();
  const store = storePda();
  const dvn = process.env.SOLANA_DVN_PUBKEY
    ? new PublicKey(process.env.SOLANA_DVN_PUBKEY)
    : admin.publicKey;
  const confirmations = BigInt(process.env.SOLANA_RECEIVE_CONFIRMATIONS ?? "1");

  const ulnConfig = {
    confirmations,
    requiredDvnCount: 1,
    optionalDvnCount: 0,
    optionalDvnThreshold: 0,
    requiredDvns: [dvn],
    optionalDvns: [] as PublicKey[],
  };

  console.log("=== Solana receive-ULN DVN config (src = Sui 40378) ===");
  console.log("  Endpoint:      ", ENDPOINT_ID.toBase58());
  console.log("  ULN302:        ", ULN_ID.toBase58());
  console.log("  Store (OApp):  ", store.toBase58());
  console.log("  Admin/delegate:", admin.publicKey.toBase58());
  console.log("  Required DVN:  ", dvn.toBase58(), dvn.equals(admin.publicKey) ? "(= admin keypair)" : "");
  console.log("  Confirmations: ", confirmations.toString());

  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);
  const uln = new UlnProgram.Uln(ULN_ID);

  // The ULN SetConfig ix references the OApp's send+receive config PDAs, which
  // must be initialized first. The forward leg sends via the DEFAULT config, so
  // these OApp-specific PDAs for eid 40378 were never created. initOAppConfig
  // creates both (idempotent: it reverts "already initialized" on re-run).
  const initIx = endpoint.initOAppConfig(
    admin.publicKey,
    uln as unknown as Parameters<typeof endpoint.initOAppConfig>[1],
    admin.publicKey,
    store,
    SUI_TESTNET_EID,
  );
  const setIx = await endpoint.setOappConfig(
    conn,
    admin.publicKey,
    store,
    ULN_ID,
    SUI_TESTNET_EID,
    {
      configType: CONFIG_TYPE_RECEIVE_ULN,
      value: ulnConfig,
    } as unknown as Parameters<typeof endpoint.setOappConfig>[5],
  );

  if (!apply) {
    // Simulate init + setConfig together (fresh state). If the config PDAs are
    // already initialized, this reverts on init; re-run --apply tolerates that.
    const tx = new Transaction().add(initIx, setIx);
    tx.feePayer = admin.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
    const sim = await conn.simulateTransaction(tx);
    if (sim.value.err) {
      console.log("\n[DRY RUN] simulate FAILED:", JSON.stringify(sim.value.err));
      console.log((sim.value.logs ?? []).join("\n"));
      console.log("\n(If the failure is init 'already in use', the config exists; --apply skips init.)");
    } else {
      console.log("\n[DRY RUN] simulate OK: initOAppConfig + setConfig(RECEIVE_ULN) would succeed. Re-run with --apply.");
    }
    return;
  }

  const send = async (label: string, ix: TransactionInstruction): Promise<void> => {
    try {
      const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin], {
        commitment: "confirmed",
      });
      console.log(`  ${label}: ${sig}`);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/already in use|already initialized|0x0\b/.test(msg)) {
        console.log(`  ${label}: already initialized, skipped`);
      } else {
        throw e;
      }
    }
  };

  console.log("\n=== BROADCASTING initOAppConfig + setOappConfig(RECEIVE_ULN) ===");
  await send("init_oapp_config", initIx);
  await send("set_receive_uln_config", setIx);
  console.log("  Receive-ULN now requires DVN", dvn.toBase58(), "for src eid", SUI_TESTNET_EID);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
