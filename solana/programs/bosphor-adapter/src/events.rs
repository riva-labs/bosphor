use anchor_lang::prelude::*;

/// Emitted when an intent is submitted on the origin (Solana) side.
#[event]
pub struct IntentSubmitted {
    /// Canonical, chain-agnostic intent id (keccak digest).
    pub intent_id: [u8; 32],
    /// Submitting Solana account.
    pub sender: Pubkey,
    /// Per-sender nonce consumed by this intent.
    pub nonce: u64,
    /// Committed Walrus blob id.
    pub blob_id: [u8; 32],
    /// Committed blob size in bytes.
    pub size: u32,
    /// Walrus encoding type discriminant.
    pub encoding_type: u8,
    /// Committed Walrus storage duration in epochs.
    pub storage_epochs: u32,
    /// Intent deadline as unix seconds.
    pub deadline: u64,
}

/// Emitted when a receive proof marks an intent executed (the `_lzReceive`
/// equivalent).
#[event]
pub struct IntentExecuted {
    /// Canonical intent id that was executed.
    pub intent_id: [u8; 32],
    /// Blob id returned in the proof (equals the committed blob id).
    pub returned_blob_id: [u8; 32],
    /// Walrus end epoch recorded from the proof.
    pub end_epoch: u64,
}
