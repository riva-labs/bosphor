use anchor_lang::prelude::*;
use oapp::{endpoint_cpi::LzAccount, LzReceiveParams};

use crate::{
    constants::{ESCROW_SEED, INTENT_SEED, LZ_RECEIVE_TYPES_SEED, PEER_SEED, STORE_SEED},
    message::decode_proof,
    state::{LzReceiveTypesAccounts, Store},
};

/// Returns the ordered account metas the endpoint Executor must pass to
/// `lz_receive` for a given inbound message. Follows the standard LayerZero OApp
/// pattern: the OApp's own accounts first (matching the `LzReceive` accounts
/// struct order), then the endpoint accounts for `clear`.
///
/// Layout returned:
///   0 - payer (executor)         [signer, writable]
///   1 - peer                     [readonly]
///   2 - store                    [readonly]
///   3 - intent                   [writable]
///   4 - escrow                   [writable]
///   5 - beneficiary              [writable]
///   6.. - accounts for `clear` (via oapp::endpoint_cpi::get_accounts_for_clear)
#[derive(Accounts)]
pub struct LzReceiveTypes<'info> {
    #[account(
        seeds = [STORE_SEED],
        bump = store.bump
    )]
    pub store: Account<'info, Store>,

    #[account(
        seeds = [LZ_RECEIVE_TYPES_SEED, store.key().as_ref()],
        bump
    )]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
}

pub fn handle_lz_receive_types(
    ctx: Context<LzReceiveTypes>,
    params: LzReceiveParams,
) -> Result<Vec<LzAccount>> {
    let store = &ctx.accounts.store;
    let store_key = store.key();

    let (peer, _) = Pubkey::find_program_address(
        &[PEER_SEED, store_key.as_ref(), &params.src_eid.to_be_bytes()],
        ctx.program_id,
    );

    // Intent PDA keyed by the intent id carried in the proof body. A malformed
    // proof yields a zero id; the on-chain `lz_receive` re-validates and rejects.
    let intent_id = match decode_proof(&params.message) {
        Ok(p) => p.intent_id,
        Err(_) => [0u8; 32],
    };
    let (intent, _) =
        Pubkey::find_program_address(&[INTENT_SEED, &intent_id], ctx.program_id);
    let (escrow, _) =
        Pubkey::find_program_address(&[ESCROW_SEED, &intent_id], ctx.program_id);

    // account 0..6 - the OApp's own accounts, matching the LzReceive struct order.
    let mut accounts = vec![
        LzAccount { pubkey: Pubkey::default(), is_signer: true, is_writable: true }, // 0 payer
        LzAccount { pubkey: peer, is_signer: false, is_writable: false },            // 1 peer
        LzAccount { pubkey: store_key, is_signer: false, is_writable: false },       // 2 store
        LzAccount { pubkey: intent, is_signer: false, is_writable: true },           // 3 intent
        LzAccount { pubkey: escrow, is_signer: false, is_writable: true },           // 4 escrow
        LzAccount { pubkey: store.admin, is_signer: false, is_writable: true },      // 5 beneficiary
    ];

    // account 4.. - the endpoint accounts required by `clear`.
    let accounts_for_clear = oapp::endpoint_cpi::get_accounts_for_clear(
        store.endpoint_program,
        &store_key,
        params.src_eid,
        &params.sender,
        params.nonce,
    );
    accounts.extend(accounts_for_clear);

    Ok(accounts)
}
