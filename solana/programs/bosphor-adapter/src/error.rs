use anchor_lang::prelude::*;

#[error_code]
pub enum BosphorError {
    #[msg("Signer is not the store admin")]
    Unauthorized,
    #[msg("Intent has already been executed")]
    AlreadyExecuted,
    #[msg("Returned blob id does not match the committed blob id")]
    BlobIdMismatch,
    #[msg("Provided intent id does not match the stored intent state")]
    IntentIdMismatch,
    #[msg("Per-sender nonce overflowed")]
    NonceOverflow,
    #[msg("Return proof sender is not the configured peer for this endpoint")]
    InvalidPeer,
    #[msg("Return proof has an invalid length or type byte")]
    InvalidProof,
}
