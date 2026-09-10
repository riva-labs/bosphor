import { OriginToken } from '../pricing/quote-engine';

/** DI token for the optional escrow reader (absent until the escrow deploy, #395). */
export const ESCROW_READER = 'ESCROW_READER';

/** The escrow terms the break-even guard needs for an intent. */
export interface EscrowInfo {
  /** Amount escrowed on the origin chain, in origin native smallest unit. */
  escrowNative: bigint;
  /** Origin chain native token the escrow is denominated in. */
  originToken: OriginToken;
}

/**
 * Reads an intent's on-chain escrow terms. Implemented against the deployed
 * escrow adapter (EVM `getEscrow(intentId)` / Solana escrow vault PDA) once the
 * escrow contracts are live (#395). Returns null when the intent has no escrow
 * (e.g. an unpriced legacy intent), in which case the guard is not applied.
 */
export interface EscrowReader {
  getEscrow(intentId: string, srcEid?: number): Promise<EscrowInfo | null>;
}
