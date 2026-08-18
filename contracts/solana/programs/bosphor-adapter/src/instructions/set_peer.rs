use anchor_lang::prelude::*;

use crate::{
    constants::{PEER_SEED, STORE_SEED},
    error::BosphorError,
    state::{Peer, Store},
};

/// Admin-only. Records the 32-byte remote OApp `address` for a given endpoint id
/// (`eid`). For the Solana <-> Sui round-trip this maps Sui testnet EID 40378 to
/// the Sui receiver address. Creates the `Peer` PDA on first set, updates it
/// thereafter.
#[derive(Accounts)]
#[instruction(params: SetPeerParams)]
pub struct SetPeer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + Peer::INIT_SPACE,
        seeds = [PEER_SEED, store.key().as_ref(), &params.eid.to_be_bytes()],
        bump
    )]
    pub peer: Account<'info, Peer>,

    #[account(
        seeds = [STORE_SEED],
        bump = store.bump,
        has_one = admin @ BosphorError::Unauthorized
    )]
    pub store: Account<'info, Store>,

    pub system_program: Program<'info, System>,
}

/// Parameters for [`SetPeer`].
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetPeerParams {
    /// The remote LayerZero endpoint id (e.g. Sui testnet 40378).
    pub eid: u32,
    /// The 32-byte remote OApp address.
    pub peer: [u8; 32],
}

pub fn handle_set_peer(ctx: Context<SetPeer>, params: SetPeerParams) -> Result<()> {
    ctx.accounts.peer.address = params.peer;
    ctx.accounts.peer.bump = ctx.bumps.peer;
    msg!("Peer set for eid {}", params.eid);
    Ok(())
}
