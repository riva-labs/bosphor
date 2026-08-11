use anchor_lang::prelude::*;

/// Seed for the singleton `Config` PDA: `[b"config"]`.
#[constant]
pub const CONFIG_SEED: &[u8] = b"config";

/// Seed prefix for the per-sender `SenderNonce` PDA: `[b"nonce", sender]`.
#[constant]
pub const NONCE_SEED: &[u8] = b"nonce";

/// Seed prefix for the per-intent `IntentState` PDA: `[b"intent", intent_id]`.
///
/// Note: the PDA address is derived from the keccak intent id but is NOT itself
/// the canonical id. The canonical intent id is the keccak digest returned by
/// `bosphor_commitment_codec::derive_intent_id`, shared across all chains.
#[constant]
pub const INTENT_SEED: &[u8] = b"intent";
