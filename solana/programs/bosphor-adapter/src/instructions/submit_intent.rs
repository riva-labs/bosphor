use anchor_lang::prelude::*;
use bosphor_commitment_codec::{derive_intent_id, Commitment};

use crate::{
    constants::{INTENT_SEED, NONCE_SEED},
    error::BosphorError,
    events::IntentSubmitted,
    state::{IntentState, SenderNonce},
};

/// Builds the canonical commitment from raw instruction args.
fn build_commitment(
    blob_id: [u8; 32],
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
) -> Commitment {
    Commitment {
        blob_id,
        size,
        encoding_type,
        storage_epochs,
        deadline,
    }
}

/// Derives the canonical intent id for a Solana sender at a given nonce.
///
/// Reuses `bosphor_commitment_codec::derive_intent_id` so the Solana adapter
/// produces the SAME id as the EVM, Sui, and TypeScript implementations. The
/// sender is the 32-byte Solana pubkey; the codec left-pads senders shorter than
/// 32 bytes, and a Solana pubkey is already exactly 32 bytes.
pub fn compute_intent_id(
    blob_id: [u8; 32],
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
    sender: &Pubkey,
    nonce: u64,
) -> [u8; 32] {
    let commitment = build_commitment(blob_id, size, encoding_type, storage_epochs, deadline);
    derive_intent_id(&commitment, sender.as_ref(), nonce)
}

#[derive(Accounts)]
#[instruction(
    blob_id: [u8; 32],
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64
)]
pub struct SubmitIntent<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Per-sender nonce PDA. Created on first submission for this sender, then
    /// incremented on every subsequent submission.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + SenderNonce::INIT_SPACE,
        seeds = [NONCE_SEED, payer.key().as_ref()],
        bump
    )]
    pub sender_nonce: Account<'info, SenderNonce>,

    /// Per-intent state PDA. Its address is derived from the canonical keccak
    /// intent id, but the id itself (not this address) is the canonical id.
    /// The seed recomputes the intent id from the args and the current nonce, so
    /// resubmitting the same commitment with a fresh nonce yields a fresh PDA.
    #[account(
        init,
        payer = payer,
        space = 8 + IntentState::INIT_SPACE,
        seeds = [
            INTENT_SEED,
            &compute_intent_id(
                blob_id,
                size,
                encoding_type,
                storage_epochs,
                deadline,
                &payer.key(),
                sender_nonce.nonce
            )
        ],
        bump
    )]
    pub intent: Account<'info, IntentState>,

    pub system_program: Program<'info, System>,
}

/// Submits a storage intent from Solana.
///
/// Derives the canonical intent id over the commitment, the 32-byte sender, and
/// the per-sender nonce, records `IntentState`, increments the nonce, and emits
/// `IntentSubmitted`.
///
/// OUT OF SCOPE (LayerZero wiring seam): after recording state, the origin path
/// will CPI into the LayerZero v2 endpoint `send` here to dispatch the intent to
/// Sui/Walrus. That endpoint CPI, its fee accounts, and options are added when the
/// LZ Solana OApp wiring lands.
#[allow(clippy::too_many_arguments)]
pub fn handle_submit_intent(
    ctx: Context<SubmitIntent>,
    blob_id: [u8; 32],
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
) -> Result<()> {
    let sender = ctx.accounts.payer.key();
    let nonce = ctx.accounts.sender_nonce.nonce;

    let intent_id = compute_intent_id(
        blob_id,
        size,
        encoding_type,
        storage_epochs,
        deadline,
        &sender,
        nonce,
    );

    let intent = &mut ctx.accounts.intent;
    intent.committed_blob_id = blob_id;
    intent.size = size;
    intent.storage_epochs = storage_epochs;
    intent.deadline = deadline;
    intent.sender = sender;
    intent.nonce = nonce;
    intent.executed = false;
    intent.end_epoch = 0;
    intent.bump = ctx.bumps.intent;

    // Consume the nonce for the next submission by this sender.
    let sender_nonce = &mut ctx.accounts.sender_nonce;
    sender_nonce.nonce = nonce.checked_add(1).ok_or(BosphorError::NonceOverflow)?;
    sender_nonce.bump = ctx.bumps.sender_nonce;

    emit!(IntentSubmitted {
        intent_id,
        sender,
        nonce,
        blob_id,
        size,
        encoding_type,
        storage_epochs,
        deadline,
    });

    msg!("Intent submitted: {}", hex32(&intent_id));
    Ok(())
}

/// Lightweight hex formatter for log lines (avoids pulling in a hex crate).
fn hex32(bytes: &[u8; 32]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(64);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}
