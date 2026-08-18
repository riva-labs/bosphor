use anchor_lang::prelude::*;

use crate::{
    constants::{INTENT_SEED, STORE_SEED, SUI_TESTNET_EID},
    error::BosphorError,
    events::IntentExecuted,
    state::{IntentState, Store},
};

/// Owner-gated return-proof fallback, the Solana mirror of the EVM adapter's
/// `confirmExecution`.
///
/// The canonical return path is `lz_receive` (a LayerZero-delivered proof from
/// Sui). On testnet the Sui send library cannot dispatch that proof (a LayerZero
/// infra fault tracked as #272), so the trusted relayer records the execution
/// result directly here instead. This does NOT weaken the reference guarantee:
/// the returned blob id is still checked against the commitment recorded at
/// submission, exactly as `lz_receive` does. It only replaces the endpoint's
/// peer/replay gate with the store admin gate, which is consistent with the
/// single-relayer trust model of this milestone.
///
/// When #272 is resolved upstream, `lz_receive` becomes primary and this stays as
/// the fallback, matching the EVM design (LZ primary, `confirmExecution` fallback).
#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct ConfirmExecution<'info> {
    /// Must be the store admin (the trusted relayer authority).
    pub admin: Signer<'info>,

    #[account(
        seeds = [STORE_SEED],
        bump = store.bump,
        has_one = admin @ BosphorError::Unauthorized
    )]
    pub store: Account<'info, Store>,

    /// The intent whose execution result is being recorded, keyed by intent id.
    #[account(
        mut,
        seeds = [INTENT_SEED, &intent_id],
        bump = intent.bump
    )]
    pub intent: Account<'info, IntentState>,
}

pub fn handle_confirm_execution(
    ctx: Context<ConfirmExecution>,
    intent_id: [u8; 32],
    returned_blob_id: [u8; 32],
    end_epoch: u64,
) -> Result<()> {
    let intent = &mut ctx.accounts.intent;
    require!(!intent.executed, BosphorError::AlreadyExecuted);
    require!(
        returned_blob_id == intent.committed_blob_id,
        BosphorError::BlobIdMismatch
    );

    intent.executed = true;
    intent.end_epoch = end_epoch;

    emit!(IntentExecuted {
        intent_id,
        returned_blob_id,
        end_epoch,
        // The proof logically originates from Sui execution; it is delivered
        // off-chain by the relayer rather than via the LayerZero endpoint.
        src_eid: SUI_TESTNET_EID,
    });

    Ok(())
}
