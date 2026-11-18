/**
 * Delivery state of a Sui -> Solana return nonce, read from the Solana endpoint
 * instead of inferred from a failed simulation (bosphor#493).
 *
 * lz_receive's Clear closes the endpoint's payload hash PDA, so a nonce at or
 * below the inbound frontier with no payload hash account was delivered (or
 * skipped by hand, which needs no action either). A nonce above the frontier
 * has no account because it was never verified, so it is still pending.
 *
 * A nonce at or below the frontier whose payload hash account still holds a
 * committed hash is verified + committed but not executed: only lz_receive is
 * left, so the worker skips verify and commitVerification for it (bosphor#525).
 */
export type ReturnDeliveryState = "delivered" | "committed" | "pending" | "unknown";

export interface EndpointNonceState {
  /** The endpoint Nonce account's inbound_nonce for our pathway. */
  inboundNonce: bigint;
  /** Whether the payload hash PDA for this nonce exists. */
  payloadHashExists: boolean;
  /** Whether that PDA holds a committed hash (not zeroed by initVerify, not nilified). */
  payloadHashCommitted?: boolean;
}

/** `state` is null when the endpoint could not be read (RPC error). */
export function returnDeliveryState(nonce: bigint, state: EndpointNonceState | null): ReturnDeliveryState {
  if (!state) return "unknown";
  if (nonce > state.inboundNonce) return "pending";
  if (!state.payloadHashExists) return "delivered";
  return state.payloadHashCommitted ? "committed" : "pending";
}
