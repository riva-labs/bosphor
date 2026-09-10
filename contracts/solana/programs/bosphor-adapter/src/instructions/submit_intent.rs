use anchor_lang::prelude::*;
use anchor_lang::system_program;
use bosphor_commitment_codec::{derive_intent_id, Commitment};
use oapp::endpoint::{instructions::SendParams as EndpointSendParams, MessagingReceipt};

use crate::{
    constants::{ESCROW_SEED, INTENT_SEED, NONCE_SEED, PEER_SEED, STORE_SEED},
    error::BosphorError,
    escrow::ESCROW_PENDING,
    events::IntentSubmitted,
    message::encode_forward,
    state::{EscrowVault, IntentState, Peer, SenderNonce, Store},
};

/// Builds the canonical commitment from raw instruction args.
fn build_commitment(
    blob_id: [u8; 32],
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
) -> Commitment {
    Commitment { blob_id, size, encoding_type, storage_epochs, deadline }
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
    deadline: u64,
    dst_eid: u32
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

    /// Per-intent escrow vault PDA. Holds the user's SOL payment (deposited from
    /// `payer`) until release on a proof or refund after the deadline.
    #[account(
        init,
        payer = payer,
        space = 8 + EscrowVault::INIT_SPACE,
        seeds = [
            ESCROW_SEED,
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
    pub escrow: Account<'info, EscrowVault>,

    /// The OApp store; it is the LayerZero "sender" and PDA-signs the endpoint
    /// `send` CPI.
    #[account(
        seeds = [STORE_SEED],
        bump = store.bump
    )]
    pub store: Account<'info, Store>,

    /// The destination peer (remote OApp address) for `dst_eid`.
    #[account(
        seeds = [PEER_SEED, store.key().as_ref(), &dst_eid.to_be_bytes()],
        bump = peer.bump
    )]
    pub peer: Account<'info, Peer>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: the endpoint accounts required by `send`. The Store PDA
    // must appear as remaining_accounts[1] (the sender).
}

/// Submits a storage intent from Solana and dispatches it to the destination
/// chain via the LayerZero v2 endpoint.
///
/// Derives the canonical intent id over the commitment, the 32-byte sender, and
/// the per-sender nonce; records `IntentState`; increments the nonce; builds the
/// 81-byte forward message `intentId ++ commitment`; CPIs the endpoint `send`;
/// and emits `IntentSubmitted` with the resulting GUID/nonce.
#[allow(clippy::too_many_arguments)]
pub fn handle_submit_intent(
    ctx: Context<SubmitIntent>,
    blob_id: [u8; 32],
    size: u32,
    encoding_type: u8,
    storage_epochs: u32,
    deadline: u64,
    dst_eid: u32,
    options: Vec<u8>,
    native_fee: u64,
    escrow_amount: u64,
) -> Result<()> {
    let sender = ctx.accounts.payer.key();
    let nonce = ctx.accounts.sender_nonce.nonce;

    let commitment = build_commitment(blob_id, size, encoding_type, storage_epochs, deadline);
    let intent_id = derive_intent_id(&commitment, sender.as_ref(), nonce);

    // Record intent state.
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

    // Record the escrow (Pending) and deposit the payment into its vault. The
    // beneficiary is the store admin (the relayer authority); release is gated on
    // a genuine proof in `lz_receive`, never on this address.
    {
        let escrow = &mut ctx.accounts.escrow;
        escrow.payer = sender;
        escrow.beneficiary = ctx.accounts.store.admin;
        escrow.amount = escrow_amount;
        escrow.deadline = deadline;
        escrow.status = ESCROW_PENDING;
        escrow.bump = ctx.bumps.escrow;
    }
    if escrow_amount > 0 {
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            escrow_amount,
        )?;
    }

    // Dispatch the forward leg via the LayerZero v2 endpoint. The Store PDA is the
    // sender and PDA-signs the CPI.
    let store = &ctx.accounts.store;
    let message = encode_forward(&intent_id, &commitment);
    let receipt: MessagingReceipt = oapp::endpoint_cpi::send(
        store.endpoint_program,
        store.key(),
        ctx.remaining_accounts,
        &[STORE_SEED, &[store.bump]],
        EndpointSendParams {
            dst_eid,
            receiver: ctx.accounts.peer.address,
            message,
            options,
            native_fee,
            lz_token_fee: 0,
        },
    )?;

    emit!(IntentSubmitted {
        intent_id,
        sender,
        nonce,
        blob_id,
        size,
        encoding_type,
        storage_epochs,
        deadline,
        dst_eid,
        guid: receipt.guid,
        lz_nonce: receipt.nonce,
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
