use anchor_lang::prelude::*;

/// Singleton OApp config PDA (`[b"store"]`).
///
/// This is the Bosphor OApp identity registered with the LayerZero v2 endpoint.
/// It is the "sender" on the forward leg (Solana -> Sui) and the "receiver" on the
/// return leg (Sui -> Solana), and it PDA-signs every endpoint CPI.
///
/// Peers (remote OApp addresses per endpoint id) are stored in separate `Peer`
/// PDAs (`[b"peer", store, eid]`), not inline, so any number of destinations can
/// be wired without a fixed-size map.
#[account]
#[derive(InitSpace)]
pub struct Store {
    /// Admin allowed to set peers and manage the OApp. Also registered as the
    /// LayerZero delegate at `init_store`.
    pub admin: Pubkey,
    /// The LayerZero v2 endpoint program this OApp is registered with.
    pub endpoint_program: Pubkey,
    /// Bump for the store PDA. Used for the endpoint-CPI signer seeds.
    pub bump: u8,
}

/// Per-destination peer PDA (`[b"peer", store, eid]`).
///
/// Records the 32-byte address of the remote Bosphor OApp for a given endpoint
/// id. On the forward leg this is the `receiver` passed to `send`; on the return
/// leg it is checked against `params.sender` in `lz_receive` for peer trust.
#[account]
#[derive(InitSpace)]
pub struct Peer {
    /// The 32-byte remote OApp address (e.g. the Sui receiver for EID 40378).
    pub address: [u8; 32],
    /// Bump for the peer PDA.
    pub bump: u8,
}

/// Account list PDA (`[b"LzReceiveTypes", store]`) read by `lz_receive_types`.
///
/// The Executor discovers this PDA via the standard LayerZero derivation and the
/// program uses it to compute the account metas the endpoint must pass to
/// `lz_receive`.
#[account]
#[derive(InitSpace)]
pub struct LzReceiveTypesAccounts {
    /// The Store (OApp) this account list belongs to.
    pub store: Pubkey,
}

/// Per-sender monotonic nonce PDA (`[b"nonce", sender]`).
///
/// The nonce feeds the canonical intent id derivation so that a given sender can
/// submit the same commitment more than once and still get a unique intent id,
/// matching the EVM adapter's per-sender nonce semantics.
#[account]
#[derive(InitSpace)]
pub struct SenderNonce {
    /// Next nonce to use for this sender.
    pub nonce: u64,
    /// Bump for the nonce PDA.
    pub bump: u8,
}

/// Per-intent state PDA (`[b"intent", intent_id]`).
///
/// The PDA address is derived from the keccak intent id, but the canonical intent
/// id is the keccak digest itself, not this account's address. This account merely
/// holds the intent's lifecycle state.
#[account]
#[derive(InitSpace)]
pub struct IntentState {
    /// The blob id committed at submission time.
    pub committed_blob_id: [u8; 32],
    /// Committed blob size in bytes.
    pub size: u32,
    /// Committed Walrus storage duration in epochs.
    pub storage_epochs: u32,
    /// Intent deadline as unix seconds.
    pub deadline: u64,
    /// The Solana account that submitted the intent.
    pub sender: Pubkey,
    /// Per-sender nonce used in the intent id derivation.
    pub nonce: u64,
    /// Whether the receive proof has been recorded.
    pub executed: bool,
    /// Walrus end epoch recorded on execution (0 until executed).
    pub end_epoch: u64,
    /// Bump for the intent PDA.
    pub bump: u8,
}
