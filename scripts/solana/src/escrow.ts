/**
 * Pure codec + accounting helpers for the adapter's per-intent escrow vault
 * (M4). Mirrors contracts/solana/programs/bosphor-adapter/src/{state,escrow}.rs.
 * No RPC here, so everything is unit-tested (escrow.test.ts).
 */

import { sha256 } from "@noble/hashes/sha2.js";

/** Escrow status codes (`EscrowVault::status`). */
export const ESCROW_PENDING = 0;
export const ESCROW_RELEASED = 1;
export const ESCROW_REFUNDED = 2;

/** 8-byte Anchor discriminator: sha256("<kind>:<name>")[..8]. */
function discriminator(preimage: string): Uint8Array {
  return sha256(new TextEncoder().encode(preimage)).slice(0, 8);
}

export interface EscrowVault {
  payer: Uint8Array;
  beneficiary: Uint8Array;
  /** Escrowed lamports (excludes the vault's rent). */
  amount: bigint;
  /** Unix seconds; refundable strictly after this. */
  deadline: bigint;
  status: number;
  bump: number;
}

/** Account size: discriminator + payer + beneficiary + amount + deadline + status + bump. */
export const ESCROW_VAULT_LEN = 8 + 32 + 32 + 8 + 8 + 1 + 1;

/** Decode an `EscrowVault` account, verifying its Anchor discriminator. */
export function decodeEscrowVault(data: Uint8Array): EscrowVault {
  if (data.length < ESCROW_VAULT_LEN) {
    throw new Error(`EscrowVault too short: ${data.length} < ${ESCROW_VAULT_LEN}`);
  }
  const want = discriminator("account:EscrowVault");
  for (let i = 0; i < 8; i++) {
    if (data[i] !== want[i]) throw new Error("account is not an EscrowVault (discriminator mismatch)");
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    payer: data.slice(8, 40),
    beneficiary: data.slice(40, 72),
    amount: dv.getBigUint64(72, true),
    deadline: dv.getBigUint64(80, true),
    status: data[88]!,
    bump: data[89]!,
  };
}

/** Encode a raw EscrowVault account (test fixtures and simulation only). */
export function encodeEscrowVault(v: EscrowVault): Uint8Array {
  const out = new Uint8Array(ESCROW_VAULT_LEN);
  out.set(discriminator("account:EscrowVault"), 0);
  out.set(v.payer, 8);
  out.set(v.beneficiary, 40);
  const dv = new DataView(out.buffer);
  dv.setBigUint64(72, v.amount, true);
  dv.setBigUint64(80, v.deadline, true);
  out[88] = v.status;
  out[89] = v.bump;
  return out;
}

/** `refund_escrow(intent_id: [u8; 32])` instruction data. */
export function encodeRefundEscrowData(intentId: Uint8Array): Uint8Array {
  if (intentId.length !== 32) throw new Error(`intentId must be 32 bytes, got ${intentId.length}`);
  const out = new Uint8Array(8 + 32);
  out.set(discriminator("global:refund_escrow"), 0);
  out.set(intentId, 8);
  return out;
}

/** Mirror of the on-chain `check_refund`: Pending and strictly past the deadline. */
export function refundAllowed(status: number, nowUnix: bigint, deadline: bigint): boolean {
  return status === ESCROW_PENDING && nowUnix > deadline;
}

/** Minimal transaction-meta shape (a subset of web3.js ConfirmedTransactionMeta). */
export interface TxMeta {
  fee: number;
  preBalances: number[];
  postBalances: number[];
}

/** Net lamport change of the account at `index` in a confirmed transaction. */
export function balanceDelta(meta: TxMeta, index: number): bigint {
  const pre = meta.preBalances[index];
  const post = meta.postBalances[index];
  if (pre === undefined || post === undefined) throw new Error(`no balance for account index ${index}`);
  return BigInt(post) - BigInt(pre);
}

/**
 * Lamports an account should gain when a vault holding `vaultLamports` (escrow +
 * rent) is closed to it: the whole vault, minus the tx fee if that account also
 * paid the fee.
 */
export function expectedCloseCredit(vaultLamports: bigint, fee: number, isFeePayer: boolean): bigint {
  return vaultLamports - (isFeePayer ? BigInt(fee) : 0n);
}
