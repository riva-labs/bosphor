/**
 * Shared config for the Bosphor Solana adapter deploy + LayerZero v2 wiring
 * toolchain (M3 #242).
 *
 * Operational tooling, not published. LayerZero program IDs are the canonical
 * LayerZero v2 Solana deployments (same address on mainnet and devnet), pinned
 * from the vendored crates in contracts/evm/lib/LayerZero-v2 and verified
 * executable on devnet.
 *
 * Network preset: NETWORK=testnet (default) pairs Solana devnet with Sui
 * testnet and keeps every historical default (devnet RPC, devnet keypair path,
 * the devnet program id). NETWORK=mainnet pairs Solana mainnet with Sui mainnet
 * and has no devnet fallbacks: SOLANA_RPC_URL, SOLANA_KEYPAIR and
 * SOLANA_PROGRAM_ID must be set explicitly or the script fails at startup.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as dotenv from "dotenv";

dotenv.config();

// --- network preset ---

export type BosphorNetwork = "testnet" | "mainnet";

interface NetworkPreset {
  /** Sui LayerZero endpoint id (the forward-leg destination, return-leg source). */
  suiEid: number;
  /** Solana LayerZero endpoint id (this OApp's own eid). */
  solanaEid: number;
  suiLabel: string;
  solanaLabel: string;
  /** Defaults only exist on testnet; mainnet values must come from env. */
  solanaRpcUrl?: string;
  keypairPath?: string;
  programId?: string;
  suiJsonRpcUrl?: string;
  /** Sui bosphor_lz PACKAGE id: the Solana peer for the Sui eid (SUI_RECEIVER). */
  suiOappPackageId?: string;
  /** Sui relayer address that sends return proofs (SUI_RELAYER_ADDR). */
  suiRelayerAddr?: string;
}

const PRESETS: Record<BosphorNetwork, NetworkPreset> = {
  testnet: {
    suiEid: 40378,
    solanaEid: 40168,
    suiLabel: "Sui testnet",
    solanaLabel: "Solana devnet",
    solanaRpcUrl: "https://api.devnet.solana.com",
    keypairPath: resolve(homedir(), ".config/solana/bosphor-devnet.json"),
    programId: "7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF",
    // The official testnet fullnode rate-limits JSON-RPC hard; publicnode is a
    // reliable free alternative.
    suiJsonRpcUrl: "https://sui-testnet-rpc.publicnode.com",
    // v6 testnet deployment.
    suiOappPackageId: "0xbaa795269923a56b3159e974ca05350318bcb6e629aea618d01fc496543efee5",
    suiRelayerAddr: "0xa11070a3877b77355a0afbc402559cae7501c666819f05491f0337016c219366",
  },
  mainnet: {
    // Canonical LayerZero v2 mainnet endpoint ids.
    suiEid: 30378,
    solanaEid: 30168,
    suiLabel: "Sui mainnet",
    solanaLabel: "Solana mainnet",
  },
};

function parseNetwork(raw: string | undefined): BosphorNetwork {
  const v = (raw ?? "testnet").trim().toLowerCase();
  if (v !== "testnet" && v !== "mainnet") {
    throw new Error(`NETWORK must be "testnet" or "mainnet", got "${raw}"`);
  }
  return v;
}

/** Selected network (NETWORK env, default testnet). */
export const NETWORK: BosphorNetwork = parseNetwork(process.env.NETWORK);
export const PRESET: NetworkPreset = PRESETS[NETWORK];

/**
 * An env value with a per-network default. On testnet the preset default
 * applies when the env var is unset; on mainnet there is no default, so a
 * missing value throws instead of silently reaching for devnet.
 */
export function setting(envName: string, presetDefault: string | undefined): string {
  const v = process.env[envName];
  if (v !== undefined && v !== "") return v;
  if (presetDefault !== undefined) return presetDefault;
  throw new Error(`${envName} must be set when NETWORK=${NETWORK} (no default for this network)`);
}

// --- program IDs ---

/**
 * The Bosphor Solana adapter (our program). The devnet program on testnet;
 * SOLANA_PROGRAM_ID is required on mainnet.
 */
export const BOSPHOR_PROGRAM_ID = new PublicKey(
  setting("SOLANA_PROGRAM_ID", PRESET.programId),
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

/**
 * Sui LayerZero endpoint id for the selected network (the forward-leg
 * destination): 40378 on testnet, 30378 on mainnet.
 */
export const SUI_EID = PRESET.suiEid;
/**
 * Solana LayerZero endpoint id for the selected network (this OApp's own eid;
 * the return-leg destination as seen by Sui): 40168 on devnet, 30168 on mainnet.
 */
export const SOLANA_EID = PRESET.solanaEid;

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

/** Solana RPC: SOLANA_RPC_URL, or the public devnet RPC on testnet only. */
export function connection(): Connection {
  return new Connection(setting("SOLANA_RPC_URL", PRESET.solanaRpcUrl), "confirmed");
}

/**
 * The deploy/admin payer keypair, loaded from SOLANA_KEYPAIR (a path to a
 * solana-cli JSON secret-key array). On testnet it defaults to the devnet
 * keypair path; on mainnet SOLANA_KEYPAIR is required.
 */
export function payer(): Keypair {
  const path = setting("SOLANA_KEYPAIR", PRESET.keypairPath);
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}
