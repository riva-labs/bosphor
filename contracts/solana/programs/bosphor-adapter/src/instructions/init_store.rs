use anchor_lang::prelude::*;
use oapp::endpoint::{instructions::RegisterOAppParams, ID as DEFAULT_ENDPOINT_ID};

use crate::{
    constants::{LZ_RECEIVE_TYPES_SEED, STORE_SEED},
    state::{LzReceiveTypesAccounts, Store},
};

/// Creates the singleton `Store` (OApp) PDA and its `LzReceiveTypesAccounts` PDA,
/// then registers the OApp with the LayerZero v2 endpoint.
///
/// The `Store` PDA is the OApp identity. It is passed as `remaining_accounts[2]`
/// (per `RegisterOApp`) and PDA-signs the `register_oapp` CPI. The endpoint
/// accounts (payer, oapp, oapp_registry, system_program, event authority) are
/// supplied as `remaining_accounts` by the caller, following the standard LZ
/// OApp pattern.
#[derive(Accounts)]
#[instruction(params: InitStoreParams)]
pub struct InitStore<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + Store::INIT_SPACE,
        seeds = [STORE_SEED],
        bump
    )]
    pub store: Account<'info, Store>,

    #[account(
        init,
        payer = payer,
        space = 8 + LzReceiveTypesAccounts::INIT_SPACE,
        seeds = [LZ_RECEIVE_TYPES_SEED, store.key().as_ref()],
        bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: the endpoint accounts required by `register_oapp`.
}

/// Parameters for [`InitStore`].
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct InitStoreParams {
    /// Admin allowed to set peers. Also registered as the LayerZero delegate.
    pub admin: Pubkey,
    /// The LayerZero v2 endpoint program id. If `None`, the crate default
    /// (`oapp::endpoint::ID`) is used.
    pub endpoint_program: Option<Pubkey>,
}

pub fn handle_init_store(ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
    let store = &mut ctx.accounts.store;
    store.admin = params.admin;
    store.endpoint_program = params.endpoint_program.unwrap_or(DEFAULT_ENDPOINT_ID);
    store.bump = ctx.bumps.store;

    ctx.accounts.lz_receive_types_accounts.store = store.key();

    let store_key = store.key();
    // Register the OApp with the endpoint. The Store PDA signs the CPI.
    oapp::endpoint_cpi::register_oapp(
        store.endpoint_program,
        store_key,
        ctx.remaining_accounts,
        &[STORE_SEED, &[store.bump]],
        RegisterOAppParams { delegate: params.admin },
    )?;

    msg!("Bosphor OApp store initialized; admin {}", params.admin);
    Ok(())
}
