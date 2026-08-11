use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, INTENT_SEED},
    error::BosphorError,
    events::IntentExecuted,
    state::{Config, IntentState},
};

#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct MarkExecuted<'info> {
    /// The receive authority. This is the seam where LayerZero endpoint delivery
    /// will later authorize the receive path: today this is a plain signer check
    /// against `config.authority`; once the LZ Solana OApp wiring lands, this is
    /// replaced (or augmented) by an endpoint CPI / PDA signer that proves the
    /// message was delivered and verified by the DVN.
    pub authority: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ BosphorError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [INTENT_SEED, intent_id.as_ref()],
        bump = intent.bump
    )]
    pub intent: Account<'info, IntentState>,
}

/// Records the receive proof for an intent (the `_lzReceive` equivalent).
///
/// Requires the signer to be the configured `Config.authority`, requires the
/// intent to not already be executed, and requires the returned blob id to match
/// the committed blob id. On success, marks the intent executed, records the
/// Walrus end epoch, and emits `IntentExecuted`.
///
/// OUT OF SCOPE (LayerZero wiring seam): in the full round-trip this is invoked by
/// the LayerZero v2 endpoint after DVN verification of the proof message from
/// Sui/Walrus. The `authority` signer check above stands in for that delivery
/// authorization until the endpoint CPI is wired.
pub fn handle_mark_executed(
    ctx: Context<MarkExecuted>,
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
    });

    Ok(())
}
