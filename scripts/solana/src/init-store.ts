/**
 * Step 1 of the Solana adapter wiring: create the Store (OApp) PDA and register
 * it with the LayerZero v2 endpoint (`init_store` -> `register_oapp` CPI).
 *
 * Run after the program `.so` is deployed to devnet. The payer becomes the OApp
 * admin and the LayerZero delegate. Idempotent-safe: exits cleanly if the Store
 * PDA already exists.
 *
 *   npm run init-store
 */

import {
  ComputeBudgetProgram,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { EndpointProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import { encodeInitStoreData } from "../../../sdk/src/solana/program.ts";
import {
  BOSPHOR_PROGRAM_ID,
  ENDPOINT_ID,
  connection,
  lzReceiveTypesPda,
  payer,
  storePda,
} from "./config.ts";

async function main(): Promise<void> {
  const conn = connection();
  const admin = payer();
  const store = storePda();
  const lzReceiveTypes = lzReceiveTypesPda(store);

  console.log("Bosphor adapter:", BOSPHOR_PROGRAM_ID.toBase58());
  console.log("Endpoint:       ", ENDPOINT_ID.toBase58());
  console.log("Admin/payer:    ", admin.publicKey.toBase58());
  console.log("Store PDA:      ", store.toBase58());
  console.log("LzReceiveTypes: ", lzReceiveTypes.toBase58());

  const existing = await conn.getAccountInfo(store);
  if (existing) {
    console.log("\nStore PDA already initialized; nothing to do.");
    return;
  }

  // The endpoint accounts required by `register_oapp`, in the order the CPI
  // helper expects. `oapp` is our Store PDA (it PDA-signs the CPI).
  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);
  const registerAccounts = await Promise.resolve(
    endpoint.getRegisterOappIxAccountMetaForCPI(admin.publicKey, store),
  );

  const keys = [
    { pubkey: admin.publicKey, isSigner: true, isWritable: true },
    { pubkey: store, isSigner: false, isWritable: true },
    { pubkey: lzReceiveTypes, isSigner: false, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ...registerAccounts,
  ];

  const data = Buffer.from(
    encodeInitStoreData(admin.publicKey.toBytes(), ENDPOINT_ID.toBytes()),
  );

  const ix = new TransactionInstruction({
    programId: BOSPHOR_PROGRAM_ID,
    keys,
    data,
  });

  const tx = new Transaction()
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }))
    .add(ix);

  console.log("\nSending init_store...");
  const sig = await sendAndConfirmTransaction(conn, tx, [admin], {
    commitment: "confirmed",
  });
  console.log("init_store confirmed:", sig);
  console.log("Store (OApp) registered with the LayerZero endpoint.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
