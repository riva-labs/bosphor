use anchor_lang::prelude::*;
use oapp::{
    endpoint::{cpi::accounts::Clear, instructions::ClearParams, ConstructCPIContext},
    LzReceiveParams,
};

use crate::{
    constants::{INTENT_SEED, PEER_SEED, STORE_SEED},
    error::BosphorError,
    events::IntentExecuted,
    message::decode_proof,
    state::{IntentState, Peer, Store},
};

/// The `_lzReceive` equivalent: the endpoint-delivered receive of the return proof
/// from Sui.
///
/// This REPLACES the old `mark_executed` authority gate with endpoint delivery
/// plus a peer check: the proof is only accepted if `params.sender` matches the
/// configured `Peer` for `params.src_eid`. Replay is prevented by the endpoint
/// `clear` CPI (which consumes the payload hash), and the intent must not already
/// be executed. The returned blob id must equal the committed blob id.
///
/// Account layout (Anchor-declared, then remaining):
///   payer, peer, store, intent, then remaining_accounts:
///     0..Clear::MIN_ACCOUNTS_LEN - the endpoint accounts required by `clear`.
#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// The peer for the source endpoint id. Its `address` must equal the proof
    /// sender for the message to be trusted.
    #[account(
        seeds = [PEER_SEED, store.key().as_ref(), &params.src_eid.to_be_bytes()],
        bump = peer.bump,
        constraint = peer.address == params.sender @ BosphorError::InvalidPeer
    )]
    pub peer: Account<'info, Peer>,

    /// The OApp store; it is the LayerZero "receiver" and PDA-signs the `clear`
    /// CPI.
    #[account(
        seeds = [STORE_SEED],
        bump = store.bump
    )]
    pub store: Account<'info, Store>,

    /// The intent whose execution proof is being recorded. Keyed by the intent id
    /// carried in the proof body.
    #[account(
        mut,
        seeds = [INTENT_SEED, &decode_intent_id(&params.message)],
        bump = intent.bump
    )]
    pub intent: Account<'info, IntentState>,
    // remaining_accounts: the endpoint accounts required by `clear`.
}

/// Extracts the intent id from a return proof for use as a PDA seed. Falls back to
/// all-zero on a malformed message; the handler re-decodes and rejects malformed
/// proofs explicitly with `InvalidProof`, and a zero-id PDA will not match a real
/// intent.
fn decode_intent_id(message: &[u8]) -> [u8; 32] {
    match decode_proof(message) {
        Ok(p) => p.intent_id,
        Err(_) => [0u8; 32],
    }
}

pub fn handle_lz_receive(ctx: Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
    // Decode and validate the 97-byte type-1 proof.
    let proof = decode_proof(&params.message).map_err(|_| error!(BosphorError::InvalidProof))?;

    // Clear the message on the endpoint for replay protection. The Store PDA
    // signs the CPI. The first `Clear::MIN_ACCOUNTS_LEN` remaining accounts are
    // the endpoint accounts for `clear`.
    let store = &ctx.accounts.store;
    let accounts_for_clear = &ctx.remaining_accounts[0..Clear::MIN_ACCOUNTS_LEN];
    oapp::endpoint_cpi::clear(
        store.endpoint_program,
        store.key(),
        accounts_for_clear,
        &[STORE_SEED, &[store.bump]],
        ClearParams {
            receiver: store.key(),
            src_eid: params.src_eid,
            sender: params.sender,
            nonce: params.nonce,
            guid: params.guid,
            message: params.message.clone(),
        },
    )?;

    // Apply the proof to the intent.
    let intent = &mut ctx.accounts.intent;
    require!(!intent.executed, BosphorError::AlreadyExecuted);
    require!(
        proof.blob_id == intent.committed_blob_id,
        BosphorError::BlobIdMismatch
    );

    intent.executed = true;
    intent.end_epoch = proof.end_epoch;

    emit!(IntentExecuted {
        intent_id: proof.intent_id,
        returned_blob_id: proof.blob_id,
        end_epoch: proof.end_epoch,
        src_eid: params.src_eid,
    });

    Ok(())
}
