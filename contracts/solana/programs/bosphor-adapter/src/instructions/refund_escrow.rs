use anchor_lang::prelude::*;

use crate::{
    constants::ESCROW_SEED,
    error::BosphorError,
    escrow::check_refund,
    events::EscrowRefunded,
    state::EscrowVault,
};

/// Permissionless refund of an intent's escrow after its deadline.
///
/// Anyone may call it (the `refunder` only pays the tx fee); the refunded funds
/// always go to the recorded `payer` (enforced by `has_one`). The vault must be
/// Pending and the deadline must have passed. `close = payer` returns the vault's
/// entire balance (escrow + rent) to the payer and closes the account, making the
/// refund one-shot by construction.
#[derive(Accounts)]
#[instruction(intent_id: [u8; 32])]
pub struct RefundEscrow<'info> {
    /// Anyone may trigger the refund; pays the transaction fee.
    #[account(mut)]
    pub refunder: Signer<'info>,

    /// The recorded payer, who receives the refunded escrow and rent.
    #[account(mut)]
    pub payer: SystemAccount<'info>,

    /// The escrow vault to refund and close.
    #[account(
        mut,
        seeds = [ESCROW_SEED, &intent_id],
        bump = escrow.bump,
        has_one = payer @ BosphorError::Unauthorized,
        close = payer
    )]
    pub escrow: Account<'info, EscrowVault>,
}

pub fn handle_refund_escrow(ctx: Context<RefundEscrow>, intent_id: [u8; 32]) -> Result<()> {
    let escrow = &ctx.accounts.escrow;
    let now = Clock::get()?.unix_timestamp;
    check_refund(escrow.status, now, escrow.deadline)?;

    emit!(EscrowRefunded {
        intent_id,
        payer: escrow.payer,
        amount: escrow.amount,
    });

    Ok(())
}
