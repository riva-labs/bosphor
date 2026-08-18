/**
 * Shared config for the Bosphor Solana adapter devnet deploy + LayerZero v2
 * wiring toolchain (M3 #242).
 *
 * Operational tooling, not published. Program IDs are the canonical LayerZero v2
 * Solana deployments (same address on mainnet and devnet), pinned from the
 * vendored crates in contracts/evm/lib/LayerZero-v2 and verified executable on
 * devnet.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

// --- program IDs ---

/** The Bosphor Solana adapter (our program). */
export const BOSPHOR_PROGRAM_ID = new PublicKey(
  "7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF",
);

/** LayerZero v2 endpoint. */
export const ENDPOINT_ID = new PublicKey(
  "76y77prsiCMvXMjuoZ5VRrhG5qYBrUMYTE5WgHqgjEn6",
);
/** LayerZero v2 ULN302 message library (send + receive). */
export const ULN_ID = new PublicKey(
  "7a4WjyR8VZ7yZz5XJAKm39BUGn5iT9CKcv2pmG9tdXVH",
);
/** LayerZero v2 executor. */
export const EXECUTOR_ID = new PublicKey(
  "6doghB248px58JSSwG4qejQ46kFMW4AMj7vzJnWZHNZn",
);
/** LayerZero v2 DVN program (the LZ Labs DVN; our self-DVN registers under it). */
export const DVN_ID = new PublicKey(
  "HtEYV4xB4wvsj5fgTkcfuChYpvGYzgzwvNhgDZQNh7wW",
);

// --- endpoint ids ---

/** Sui testnet LayerZero endpoint id (the forward-leg destination). */
export const SUI_TESTNET_EID = 40378;
/**
 * Solana devnet LayerZero endpoint id (this OApp's own eid; the return-leg
 * source as seen by Sui). Confirm against LZ's deployed endpoints before wiring
 * the reciprocal Sui peer.
 */
export const SOLANA_DEVNET_EID = 40168;

// --- PDA seeds (must match contracts/solana/programs/bosphor-adapter/src/constants.rs) ---

const STORE_SEED = Buffer.from("store");
const PEER_SEED = Buffer.from("peer");
const NONCE_SEED = Buffer.from("nonce");
const INTENT_SEED = Buffer.from("intent");
const LZ_RECEIVE_TYPES_SEED = Buffer.from("LzReceiveTypes");

/** The singleton Store (OApp) PDA. It is the LayerZero sender/receiver identity. */
export function storePda(): PublicKey {
  return PublicKey.findProgramAddressSync([STORE_SEED], BOSPHOR_PROGRAM_ID)[0];
}

export function lzReceiveTypesPda(store: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [LZ_RECEIVE_TYPES_SEED, store.toBuffer()],
    BOSPHOR_PROGRAM_ID,
  )[0];
}

/** Peer PDA for a destination endpoint id (eid encoded big-endian, u32). */
export function peerPda(store: PublicKey, eid: number): PublicKey {
  const eidBe = Buffer.alloc(4);
  eidBe.writeUInt32BE(eid);
  return PublicKey.findProgramAddressSync(
    [PEER_SEED, store.toBuffer(), eidBe],
    BOSPHOR_PROGRAM_ID,
  )[0];
}

export function noncePda(sender: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [NONCE_SEED, sender.toBuffer()],
    BOSPHOR_PROGRAM_ID,
  )[0];
}

export function intentPda(intentId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync(
    [INTENT_SEED, Buffer.from(intentId)],
    BOSPHOR_PROGRAM_ID,
  )[0];
}

// --- connection + payer ---

/** Devnet RPC. Override with SOLANA_RPC_URL. */
export function connection(): Connection {
  return new Connection(
    process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    "confirmed",
  );
}

/**
 * The deploy/admin payer keypair. Loaded from SOLANA_KEYPAIR (a solana-cli JSON
 * secret-key array) or the default devnet path. Never the mainnet root wallet.
 */
export function payer(): Keypair {
  const path =
    process.env.SOLANA_KEYPAIR ??
    resolve(homedir(), ".config/solana/bosphor-devnet.json");
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}
