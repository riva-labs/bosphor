//! Bosphor Solana adapter.
//!
//! On-chain reference logic for the Solana leg of the Bosphor cross-chain storage
//! intent router. This program owns the origin-side intent submission and the
//! receive-proof state machine (`mark_executed`, the `_lzReceive` equivalent).
//!
//! The LayerZero v2 Solana OApp wiring (endpoint CPI for send/receive, DVN, and
//! cross-chain message delivery) is intentionally OUT OF SCOPE here. The receive
//! path is gated behind a configurable `Config.authority` today; the comments in
//! `submit_intent` and `mark_executed` mark the exact seams where the LZ endpoint
//! CPI will slot in as a clean follow-on.
//!
//! Intent ids are derived with `bosphor_commitment_codec::derive_intent_id`, the
//! shared canonical codec, so a Solana-submitted intent gets the SAME id as the
//! EVM, Sui, and TypeScript implementations.

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use events::*;
pub use instructions::*;
pub use state::*;

declare_id!("7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF");

#[program]
pub mod bosphor_adapter {
    use super::*;

    /// Creates the singleton `Config` PDA storing the receive authority.
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        instructions::initialize::handle_initialize(ctx, authority)
    }

    /// Submits a storage intent from Solana and records its `IntentState`.
    pub fn submit_intent(
        ctx: Context<SubmitIntent>,
        blob_id: [u8; 32],
        size: u32,
        encoding_type: u8,
        storage_epochs: u32,
        deadline: u64,
    ) -> Result<()> {
        instructions::submit_intent::handle_submit_intent(
            ctx,
            blob_id,
            size,
            encoding_type,
            storage_epochs,
            deadline,
        )
    }

    /// Records the receive proof for an intent (the `_lzReceive` equivalent).
    pub fn mark_executed(
        ctx: Context<MarkExecuted>,
        intent_id: [u8; 32],
        returned_blob_id: [u8; 32],
        end_epoch: u64,
    ) -> Result<()> {
        instructions::mark_executed::handle_mark_executed(
            ctx,
            intent_id,
            returned_blob_id,
            end_epoch,
        )
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
        let intent_id = compute_intent_id(
            [0u8; 32],
            0,
            0,
            0,
            0,
            &Pubkey::new_from_array([0u8; 32]),
            0,
        );
        assert_eq!(
            hex(&intent_id),
            "496e418294117864002a95f894a01c9cc414c86e17325489a5ea2f0eef181967",
        );
    }
}
