/**
 * Step 2: point the OApp's send library (dst Sui) and receive library (src Sui)
 * at the LayerZero ULN302 message library.
 *
 * Sends each endpoint instruction as its own transaction and tolerates the
 * "already initialized" case so the script is re-runnable.
 *
 *   npm run set-libraries
 */

import {
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { EndpointProgram } from "@layerzerolabs/lz-solana-sdk-v2";
import {
  ENDPOINT_ID,
  SUI_TESTNET_EID,
  ULN_ID,
  connection,
  payer,
  storePda,
} from "./config.ts";

async function main(): Promise<void> {
  const conn = connection();
  const admin = payer();
  const store = storePda();
  const endpoint = new EndpointProgram.Endpoint(ENDPOINT_ID);

  console.log("Store PDA:", store.toBase58());
  console.log("ULN302:   ", ULN_ID.toBase58());
  console.log("Sui EID:  ", SUI_TESTNET_EID);

  async function send(label: string, ix: TransactionInstruction): Promise<void> {
    try {
      const sig = await sendAndConfirmTransaction(
        conn,
        new Transaction().add(ix),
        [admin],
        { commitment: "confirmed" },
      );
      console.log(`  ${label}: ${sig}`);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/already in use|0x0\b|custom program error: 0x0/.test(msg)) {
        console.log(`  ${label}: already initialized, skipped`);
      } else {
        throw e;
      }
    }
  }

  console.log("\nSend library (dst Sui):");
  await send(
    "init_send_library",
    endpoint.initSendLibrary(admin.publicKey, store, SUI_TESTNET_EID),
  );
  await send(
    "set_send_library",
    endpoint.setSendLibrary(admin.publicKey, store, ULN_ID, SUI_TESTNET_EID),
  );

  console.log("\nReceive library (src Sui):");
  await send(
    "init_receive_library",
    endpoint.initReceiveLibrary(admin.publicKey, store, SUI_TESTNET_EID),
  );
  await send(
    "set_receive_library",
    endpoint.setReceiveLibrary(
      admin.publicKey,
      store,
      ULN_ID,
      SUI_TESTNET_EID,
      BigInt(0),
    ),
  );

  console.log("\nLibraries wired.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
