//! Bosphor Solana adapter, a LayerZero v2 OApp.
//!
//! On-chain logic for the Solana leg of the Bosphor cross-chain storage intent
//! router. This program is a LayerZero v2 OApp: it registers with the endpoint,
//! dispatches storage intents to a destination chain (Sui/Walrus) over LayerZero,
//! and receives the execution proof back through the endpoint.
//!
//! Forward leg (Solana -> Sui): `submit_intent` records `IntentState` and CPIs the
//! endpoint `send` with the 81-byte message `intentId(32) ++ commitment(49)`,
//! exactly what the Sui `lz_receive` parses.
//!
//! Return leg (Sui -> Solana): the endpoint invokes `lz_receive` with the 97-byte
//! type-1 proof `[0x01] ++ intentId(32) ++ blobId(32) ++ endEpoch(u256)`. The
//! program checks the proof sender against the configured peer, `clear`s the
//! message for replay protection, verifies the returned blob id matches the
//! commitment, and marks the intent executed.
//!
//! Intent ids are derived with `bosphor_commitment_codec::derive_intent_id`, the
//! shared canonical codec, so a Solana-submitted intent gets the SAME id as the
//! EVM, Sui, and TypeScript implementations.

pub mod constants;
pub mod error;
pub mod escrow;
pub mod events;
pub mod instructions;
pub mod message;
pub mod state;

use anchor_lang::prelude::*;
use oapp::{endpoint_cpi::LzAccount, LzReceiveParams};

pub use constants::*;
pub use error::*;
pub use escrow::*;
pub use events::*;
pub use instructions::*;
pub use message::*;
pub use state::*;

declare_id!("7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF");

#[program]
pub mod bosphor_adapter {
    use super::*;

    /// Creates the `Store` (OApp) PDA and registers it with the LayerZero v2
    /// endpoint. The endpoint accounts for `register_oapp` are passed as
    /// `remaining_accounts`.
    pub fn init_store(ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
        instructions::init_store::handle_init_store(ctx, params)
    }

    /// Admin-only. Records the 32-byte remote OApp address for an endpoint id
    /// (e.g. the Sui receiver for EID 40378).
    pub fn set_peer(ctx: Context<SetPeer>, params: SetPeerParams) -> Result<()> {
        instructions::set_peer::handle_set_peer(ctx, params)
    }

    /// Submits a storage intent from Solana, records its `IntentState`, and
    /// dispatches the forward leg over LayerZero. The endpoint accounts for `send`
    /// are passed as `remaining_accounts` (the Store PDA must be
    /// `remaining_accounts[1]`).
    #[allow(clippy::too_many_arguments)]
    pub fn submit_intent(
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
        instructions::submit_intent::handle_submit_intent(
            ctx,
            blob_id,
            size,
            encoding_type,
            storage_epochs,
            deadline,
            dst_eid,
            options,
            native_fee,
            escrow_amount,
        )
    }

    /// The `_lzReceive` equivalent: endpoint-delivered receive of the return proof
    /// from Sui. Verifies the peer, clears the message, and marks the intent
    /// executed.
    pub fn lz_receive(ctx: Context<LzReceive>, params: LzReceiveParams) -> Result<()> {
        instructions::lz_receive::handle_lz_receive(ctx, params)
    }

    /// Owner-gated return-proof fallback (the Solana mirror of EVM
    /// `confirmExecution`). Records the execution result directly from the trusted
    /// relayer when the LayerZero return path is unavailable, still asserting the
    /// returned blob id matches the commitment. See `confirm_execution` for the
    /// rationale.
    pub fn confirm_execution(
        ctx: Context<ConfirmExecution>,
        intent_id: [u8; 32],
        returned_blob_id: [u8; 32],
        end_epoch: u64,
    ) -> Result<()> {
        instructions::confirm_execution::handle_confirm_execution(
            ctx,
            intent_id,
            returned_blob_id,
            end_epoch,
        )
    }

    /// Permissionlessly refunds an intent's escrow to its payer after the
    /// deadline, then closes the vault (rent returned to the payer). Funds only
    /// ever go to the recorded payer; the deadline gate makes it safe for anyone
    /// to call.
    pub fn refund_escrow(ctx: Context<RefundEscrow>, intent_id: [u8; 32]) -> Result<()> {
        instructions::refund_escrow::handle_refund_escrow(ctx, intent_id)
    }

    /// Returns the account metas the endpoint Executor must pass to `lz_receive`.
    pub fn lz_receive_types(
        ctx: Context<LzReceiveTypes>,
        params: LzReceiveParams,
    ) -> Result<Vec<LzAccount>> {
        instructions::lz_receive_types::handle_lz_receive_types(ctx, params)
    }
}

#[cfg(test)]
mod tests {
    //! Cross-chain parity: the adapter's intent id derivation must match the
    //! frozen vectors from `solana/commitment-codec` (which are in turn pinned to
    //! the shared cross-chain vectors). This proves the Solana adapter derives the
    //! same canonical intent id as the EVM, Sui, and TypeScript sides.
    use crate::instructions::submit_intent::compute_intent_id;
    use anchor_lang::prelude::Pubkey;

    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len() / 2)
            .map(|i| u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).unwrap())
            .collect()
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    /// Frozen parity vector #4 from `commitment-codec/tests/parity_vectors.rs`.
    /// Its sender is a full 32-byte value, exactly like a Solana pubkey, so it is
    /// the right vector to prove Solana-side parity.
    #[test]
    fn intent_id_matches_frozen_parity_vector() {
        let blob_id: [u8; 32] =
            unhex("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef")
                .try_into()
                .unwrap();
        let sender_bytes: [u8; 32] =
            unhex("cafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe")
                .try_into()
                .unwrap();
        let sender = Pubkey::new_from_array(sender_bytes);

        let intent_id = compute_intent_id(
            blob_id,
            /* size */ 1,
            /* encoding_type */ 2,
            /* storage_epochs */ 10,
            /* deadline */ 1_234_567_890,
            &sender,
            /* nonce */ 1,
        );

        assert_eq!(
            hex(&intent_id),
            "58564b85f5eeb8341134919fc24d54b4a6df32f86bf579cadbd1bcb131b8bb17",
            "Solana adapter intent id must match the frozen cross-chain parity vector"
        );
    }

    /// The all-zero vector (#1) with a 32-byte zero sender: another cross-chain
    /// anchor point to guard against accidental encoding drift.
    #[test]
    fn intent_id_matches_zero_vector() {
        let intent_id =
            compute_intent_id([0u8; 32], 0, 0, 0, 0, &Pubkey::new_from_array([0u8; 32]), 0);
        assert_eq!(
            hex(&intent_id),
            "496e418294117864002a95f894a01c9cc414c86e17325489a5ea2f0eef181967",
        );
    }
}
