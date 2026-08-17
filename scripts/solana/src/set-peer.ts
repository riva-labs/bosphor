/**
 * Step 4: register the Sui receiver as this OApp's peer for the Sui endpoint id
 * (40378). LayerZero peers use the Sui PACKAGE id, not the OApp object id (same
 * rule as the EVM adapter's setPeer for Sui).
 *
 * The reciprocal side (Sui's peer for Solana EID 40168 -> this Store PDA) is set
 * on Sui separately.
 *
 *   npm run set-peer
 */

import {
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { encodeSetPeerData } from "../../../sdk/src/solana/program.ts";
import {
  BOSPHOR_PROGRAM_ID,
  SUI_TESTNET_EID,
  connection,
  payer,
  peerPda,
  storePda,
} from "./config.ts";

/** Sui receiver = the Sui bosphor_lz PACKAGE id (v6). Override with SUI_RECEIVER. */
const SUI_RECEIVER =
  process.env.SUI_RECEIVER ??
  "0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5";

function receiverBytes(): Uint8Array {
  const hex = SUI_RECEIVER.startsWith("0x") ? SUI_RECEIVER.slice(2) : SUI_RECEIVER;
  const b = Buffer.from(hex, "hex");
  if (b.length !== 32) throw new Error(`SUI_RECEIVER must be 32 bytes, got ${b.length}`);
  return b;
}

async function main(): Promise<void> {
  const conn = connection();
  const admin = payer();
  const store = storePda();
  const peer = peerPda(store, SUI_TESTNET_EID);
  const receiver = receiverBytes();

  console.log("Store PDA:   ", store.toBase58());
  console.log("Peer PDA:    ", peer.toBase58());
  console.log("Sui EID:     ", SUI_TESTNET_EID);
  console.log("Sui receiver:", SUI_RECEIVER);

  const ix = new TransactionInstruction({
    programId: BOSPHOR_PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: peer, isSigner: false, isWritable: true },
      { pubkey: store, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(encodeSetPeerData(SUI_TESTNET_EID, receiver)),
  });

  const sig = await sendAndConfirmTransaction(conn, new Transaction().add(ix), [admin], {
    commitment: "confirmed",
  });
  console.log("\nset_peer confirmed:", sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
