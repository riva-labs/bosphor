use anchor_lang::prelude::*;

/// Emitted when an intent is submitted on the origin (Solana) side and dispatched
/// to the destination chain via the LayerZero v2 endpoint.
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
    /// Destination LayerZero endpoint id (e.g. Sui testnet 40378).
    pub dst_eid: u32,
    /// LayerZero message GUID of the forward leg (from the messaging receipt).
    pub guid: [u8; 32],
    /// LayerZero nonce of the forward leg (from the messaging receipt).
    pub lz_nonce: u64,
}

/// Emitted when a return proof, delivered by the LayerZero v2 endpoint, marks an
/// intent executed (the `_lzReceive` equivalent).
#[event]
pub struct IntentExecuted {
    /// Canonical intent id that was executed.
    pub intent_id: [u8; 32],
    /// Blob id returned in the proof (equals the committed blob id).
    pub returned_blob_id: [u8; 32],
    /// Walrus end epoch recorded from the proof.
    pub end_epoch: u64,
    /// Source LayerZero endpoint id the proof arrived from.
    pub src_eid: u32,
}

/// Emitted when an intent's escrow is refunded to its payer after the deadline.
#[event]
pub struct EscrowRefunded {
    /// Canonical intent id whose escrow was refunded.
    pub intent_id: [u8; 32],
    /// The payer who received the refund.
    pub payer: Pubkey,
    /// Escrowed lamports returned (excludes the vault rent, also returned).
    pub amount: u64,
}
