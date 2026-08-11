use anchor_lang::prelude::*;

use crate::{constants::CONFIG_SEED, state::Config};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

/// Creates the singleton `Config` PDA storing the receive authority.
///
/// The `authority` is the account permitted to submit receive proofs via
/// `mark_executed`. It is passed in explicitly (rather than defaulting to the
/// payer) so the deployer can point it at the eventual LayerZero receive
/// authority PDA once the endpoint wiring lands.
pub fn handle_initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = authority;
    config.bump = ctx.bumps.config;
    msg!("Bosphor adapter initialized with authority {}", authority);
    Ok(())
}
