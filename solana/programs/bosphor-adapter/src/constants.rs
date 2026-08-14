use anchor_lang::prelude::*;

/// Seed for the singleton `Store` PDA: `[b"store"]`.
///
/// The `Store` PDA is the Bosphor OApp identity: it is the account registered
/// with the LayerZero v2 endpoint (`register_oapp`) and it is the "sender" on the
/// forward leg and the "receiver" on the return leg. It PDA-signs every endpoint
/// CPI (`send`, `clear`) via the seeds `[STORE_SEED, &[bump]]`.
#[constant]
pub const STORE_SEED: &[u8] = b"store";

/// Seed prefix for the per-destination `Peer` PDA: `[b"peer", store, eid]`.
///
/// A `Peer` records the 32-byte remote OApp address for a given endpoint id
/// (e.g. the Sui receiver for EID 40378). It is the trust anchor for both the
/// forward `send` (receiver address) and the return `lz_receive` (sender check).
#[constant]
pub const PEER_SEED: &[u8] = b"peer";

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

/// Seed for the `LzReceiveTypesAccounts` PDA: `[b"LzReceiveTypes", store]`.
///
/// Re-exported from the LZ `oapp` crate so the Executor discovers the account
/// list PDA using the standard LayerZero derivation.
pub const LZ_RECEIVE_TYPES_SEED: &[u8] = oapp::LZ_RECEIVE_TYPES_SEED;

/// Sui testnet LayerZero endpoint id. The Sui receiver peer is registered here.
#[constant]
pub const SUI_TESTNET_EID: u32 = 40378;
