use anchor_lang::prelude::*;

/// Singleton config PDA (`[b"config"]`) holding the authority allowed to submit
/// receive proofs via `mark_executed`.
///
/// For now the authority is a plain pubkey set at `initialize`. This is the seam
/// where the LayerZero v2 endpoint delivery will later be authorized: once the LZ
/// Solana OApp wiring lands, `mark_executed` will be gated on an endpoint CPI /
/// PDA signer instead of (or in addition to) this authority.
#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Authority permitted to mark intents executed (the receive-proof path).
    pub authority: Pubkey,
    /// Bump for the config PDA.
    pub bump: u8,
}

/// Per-sender monotonic nonce PDA (`[b"nonce", sender]`).
///
/// The nonce feeds the canonical intent id derivation so that a given sender can
/// submit the same commitment more than once and still get a unique intent id,
/// matching the EVM adapter's per-sender nonce semantics.
#[account]
#[derive(InitSpace)]
pub struct SenderNonce {
    /// Next nonce to use for this sender.
    pub nonce: u64,
    /// Bump for the nonce PDA.
    pub bump: u8,
}

/// Per-intent state PDA (`[b"intent", intent_id]`).
///
/// The PDA address is derived from the keccak intent id, but the canonical intent
/// id is the keccak digest itself, not this account's address. This account merely
/// holds the intent's lifecycle state.
#[account]
#[derive(InitSpace)]
pub struct IntentState {
    /// The blob id committed at submission time.
    pub committed_blob_id: [u8; 32],
    /// Committed blob size in bytes.
    pub size: u32,
    /// Committed Walrus storage duration in epochs.
    pub storage_epochs: u32,
    /// Intent deadline as unix seconds.
    pub deadline: u64,
    /// The Solana account that submitted the intent.
    pub sender: Pubkey,
    /// Per-sender nonce used in the intent id derivation.
    pub nonce: u64,
    /// Whether the receive proof has been recorded.
    pub executed: bool,
    /// Walrus end epoch recorded on execution (0 until executed).
    pub end_epoch: u64,
    /// Bump for the intent PDA.
    pub bump: u8,
}
