/// Bosphor LayerZero OApp: Receiver + Sender
///
/// Receives cross-chain intent messages from EVM via LayerZero v2 and sends
/// execution proofs back to EVM via the LZ return path.
///
/// ## Message Flow
///
/// **Inbound (EVM to Sui):**
/// EVM `submitIntent` -> LayerZero -> `lz_receive` -> `IntentReceived` event
///
/// **Outbound (Sui to EVM):**
/// Relayer calls `lz_send_proof` -> LayerZero -> EVM `_lzReceive` confirms execution
#[allow(lint(self_transfer))]
module bosphor_lz::lz_receiver;

use bosphor_lz::codec;
use call::call::{Call, Void};
use call::call_cap::CallCap;
use endpoint_v2::endpoint_quote::QuoteParam;
use endpoint_v2::endpoint_send::SendParam;
use endpoint_v2::endpoint_v2;
use endpoint_v2::lz_receive::LzReceiveParam;
use endpoint_v2::messaging_fee::MessagingFee;
use endpoint_v2::messaging_receipt::MessagingReceipt;
use oapp::oapp::{Self, OApp, AdminCap};
use sui::coin::Coin;
use sui::event;
use sui::sui::SUI;
use sui::table::{Self, Table};
use utils::bytes32::Bytes32;
use zro::zro::ZRO;

// === Errors ===

/// Intent with this ID was already received and recorded.
const EIntentAlreadyReceived: u64 = 0;
/// Message payload is shorter than the minimum 32 bytes (missing intent_id).
const EInvalidMessageLength: u64 = 1;
/// Caller is not the authorized relayer.
const EUnauthorizedRelayer: u64 = 2;
/// Relayer address must not be zero.
const EZeroAddress: u64 = 3;
/// Intent must exist before sending proof.
const EIntentNotReceived: u64 = 4;

// === Structs ===

/// One-time witness for module initialization. Used to create the OApp.
public struct LZ_RECEIVER has drop {}

/// Shared configuration for the LayerZero receiver.
///
/// Holds the OApp call capability (required for endpoint interactions),
/// a deduplication table of received intents, and the authorized relayer address.
public struct LzReceiverConfig has key {
    id: UID,
    /// CallCap for invoking OApp operations on the LZ endpoint.
    oapp_cap: CallCap,
    /// Deduplication table keyed by 32-byte intent ID.
    received_intents: Table<vector<u8>, IntentRecord>,
    /// Address authorized to trigger proof sends back to EVM.
    relayer: address,
}

/// Record of a received cross-chain intent.
///
/// Stored in `LzReceiverConfig.received_intents` after successful `lz_receive`.
public struct IntentRecord has store {
    /// Full ABI-encoded message payload from the EVM source.
    payload: vector<u8>,
    /// LayerZero endpoint ID of the source chain (e.g. 40161 for Sepolia).
    src_eid: u32,
    /// LayerZero message nonce for ordering and replay protection.
    nonce: u64,
}

// === Events ===

/// Emitted when the LZ executor delivers an intent from EVM.
///
/// The relayer watches for this event to trigger Walrus upload and proof return.
public struct IntentReceived has copy, drop {
    /// 32-byte unique identifier extracted from the first 32 bytes of the message.
    intent_id: vector<u8>,
    /// Full ABI-encoded message payload from EVM.
    payload: vector<u8>,
    /// LayerZero endpoint ID of the source chain.
    src_eid: u32,
    /// LayerZero message nonce.
    nonce: u64,
    /// Globally unique identifier assigned by LayerZero.
    guid: Bytes32,
}

/// Emitted when a proof is sent back to EVM via LayerZero.
///
/// Confirms that `lz_send_proof` and `confirm_lz_send_proof` completed successfully.
public struct ProofSent has copy, drop {
    /// 32-byte intent identifier matching the original `IntentReceived`.
    intent_id: vector<u8>,
    /// 32-byte Walrus blob identifier proving the data was stored.
    blob_id: vector<u8>,
    /// Walrus storage epoch at which the blob expires.
    end_epoch: u64,
    /// LayerZero endpoint ID of the destination chain (EVM).
    dst_eid: u32,
    /// LayerZero message nonce for the outbound proof message.
    nonce: u64,
    /// Globally unique identifier assigned by LayerZero for the proof message.
    guid: Bytes32,
}

// === Init ===

/// Module initializer. Creates the OApp, shares the LzReceiverConfig, and
/// transfers the admin capability to the deployer.
fun init(otw: LZ_RECEIVER, ctx: &mut TxContext) {
    let (oapp_cap, admin_cap, _oapp_addr) = oapp::new(&otw, ctx);
    let config = LzReceiverConfig {
        id: object::new(ctx),
        oapp_cap,
        received_intents: table::new(ctx),
        relayer: ctx.sender(),
    };
    transfer::share_object(config);
    transfer::public_transfer(admin_cap, ctx.sender());
}

// === Public-Mutative ===

/// Called by the LZ executor via PTB. Consumes the hot-potato `Call`, validates
/// the message through the OApp (peer + endpoint checks), extracts the intent ID,
/// records the intent, and emits an `IntentReceived` event.
///
/// Any SUI value attached to the message is forwarded to the transaction sender.
///
/// Message format from EVM (abi.encode):
///   [0:32]    intentId (bytes32)
///   [32:64]   sender (address, left-padded to 32 bytes)
///   [64:96]   offset to payload data
///   [96:128]  deadline (uint256)
///   [128:160] payload length
///   [160:...] payload data
///
/// * `config` - Shared LzReceiverConfig holding the CallCap and intent table.
/// * `oapp` - The OApp shared object for peer/endpoint validation.
/// * `call` - Hot-potato Call object from the LZ executor.
///
/// Aborts with `EInvalidMessageLength` if the message is shorter than 32 bytes.
/// Aborts with `EIntentAlreadyReceived` if the intent ID is already recorded.
public fun lz_receive(
    config: &mut LzReceiverConfig,
    oapp: &OApp,
    call: Call<LzReceiveParam, Void>,
    ctx: &mut TxContext,
) {
    // OApp validates: caller == endpoint, peer check
    let param = oapp.lz_receive(&config.oapp_cap, call);
    let (src_eid, _sender, nonce, guid, message, _executor, _extra, value) = param.destroy();

    // Extract intent_id: first 32 bytes of ABI-encoded message
    assert!(message.length() >= 32, EInvalidMessageLength);
    let intent_id = slice(&message, 0, 32);

    assert!(!config.received_intents.contains(intent_id), EIntentAlreadyReceived);

    let payload = message;

    config.received_intents.add(intent_id, IntentRecord {
        payload,
        src_eid,
        nonce,
    });

    event::emit(IntentReceived {
        intent_id,
        payload,
        src_eid,
        nonce,
        guid,
    });

    // Return any SUI value to tx sender
    if (value.is_some()) {
        transfer::public_transfer(value.destroy_some(), ctx.sender());
    } else {
        value.destroy_none();
    };
}

/// Initiates an LZ send of the execution proof back to EVM.
///
/// Builds the type-1 proof message and calls `oapp::lz_send()`. Returns the
/// hot-potato `Call` that must be routed through the LZ endpoint in the same PTB,
/// then finalized via `confirm_lz_send_proof`.
///
/// Only the authorized relayer can call this function.
///
/// * `config` - Shared LzReceiverConfig (checks relayer auth and intent existence).
/// * `oapp` - Mutable reference to the OApp for sending.
/// * `intent_id` - 32-byte intent identifier (must already exist in received_intents).
/// * `blob_id` - 32-byte Walrus blob identifier proving storage.
/// * `end_epoch` - Walrus storage epoch at which the blob expires.
/// * `dst_eid` - LayerZero endpoint ID of the destination chain (EVM).
/// * `options` - LZ messaging options (executor gas, etc.).
/// * `native_fee` - SUI coin to cover LayerZero messaging fees.
/// * `ctx` - Transaction context, used to verify the sender is the authorized relayer.
///
/// Aborts with `EUnauthorizedRelayer` if the caller is not the authorized relayer.
/// Aborts with `EIntentNotReceived` if the intent ID is not in received_intents.
public fun lz_send_proof(
    config: &LzReceiverConfig,
    oapp: &mut OApp,
    intent_id: vector<u8>,
    blob_id: vector<u8>,
    end_epoch: u64,
    dst_eid: u32,
    options: vector<u8>,
    native_fee: Coin<SUI>,
    ctx: &mut TxContext,
): Call<SendParam, MessagingReceipt> {
    assert!(ctx.sender() == config.relayer, EUnauthorizedRelayer);
    assert!(config.received_intents.contains(intent_id), EIntentNotReceived);

    let message = codec::encode(intent_id, blob_id, end_epoch);
    oapp.lz_send(
        &config.oapp_cap,
        dst_eid,
        message,
        options,
        native_fee,
        option::none<Coin<ZRO>>(),
        option::some(ctx.sender()),
        ctx,
    )
}

/// Finalizes the LZ send and handles coin refunds.
///
/// Must be called after the `Call` from `lz_send_proof` has been executed by the
/// LZ endpoint. Extracts the receipt, refunds remaining SUI to the sender, and
/// emits a `ProofSent` event.
///
/// * `config` - Shared LzReceiverConfig (provides the CallCap).
/// * `oapp` - Mutable reference to the OApp for confirming the send.
/// * `call` - Hot-potato Call returned by the LZ endpoint after processing the send.
/// * `ctx` - Transaction context, used to transfer SUI/ZRO refunds to the sender.
public fun confirm_lz_send_proof(
    config: &LzReceiverConfig,
    oapp: &mut OApp,
    call: Call<SendParam, MessagingReceipt>,
    ctx: &mut TxContext,
) {
    let (send_param, receipt) = oapp.confirm_lz_send(&config.oapp_cap, call);

    // Extract proof details from the message before destroying SendParam
    let message = *send_param.message();
    let dst_eid = send_param.dst_eid();
    let intent_id = slice(&message, 1, 32);
    let blob_id = slice(&message, 33, 32);
    let end_epoch = decode_u64_from_u256(&message, 65);

    // Destroy SendParam, handle coin refunds
    let (sui_refund, zro_refund) = send_param.destroy();
    if (sui_refund.value() > 0) {
        transfer::public_transfer(sui_refund, ctx.sender());
    } else {
        sui_refund.destroy_zero();
    };
    if (zro_refund.is_some()) {
        transfer::public_transfer(zro_refund.destroy_some(), ctx.sender());
    } else {
        zro_refund.destroy_none();
    };

    event::emit(ProofSent {
        intent_id,
        blob_id,
        end_epoch,
        dst_eid,
        nonce: receipt.nonce(),
        guid: receipt.guid(),
    });
}

/// Estimates the LZ fee for sending a proof message.
///
/// Returns a hot-potato `Call` that must be routed through the LZ endpoint for
/// quote processing, then finalized via `confirm_quote_proof`.
///
/// * `config` - Shared LzReceiverConfig (provides the CallCap).
/// * `oapp` - The OApp shared object.
/// * `intent_id` - 32-byte intent identifier.
/// * `blob_id` - 32-byte Walrus blob identifier.
/// * `end_epoch` - Walrus storage epoch at which the blob expires.
/// * `dst_eid` - LayerZero endpoint ID of the destination chain (EVM).
/// * `options` - LZ messaging options for fee estimation.
/// * `ctx` - Transaction context, required by the LZ endpoint quote call.
public fun quote_proof(
    config: &LzReceiverConfig,
    oapp: &OApp,
    intent_id: vector<u8>,
    blob_id: vector<u8>,
    end_epoch: u64,
    dst_eid: u32,
    options: vector<u8>,
    ctx: &mut TxContext,
): Call<QuoteParam, MessagingFee> {
    let message = codec::encode(intent_id, blob_id, end_epoch);
    oapp.quote(
        &config.oapp_cap,
        dst_eid,
        message,
        options,
        false,
        ctx,
    )
}

/// Finalizes a quote and returns the estimated messaging fee.
///
/// * `config` - Shared LzReceiverConfig (provides the CallCap).
/// * `oapp` - The OApp shared object.
/// * `call` - Hot-potato Call returned by the LZ endpoint after processing the quote.
public fun confirm_quote_proof(
    config: &LzReceiverConfig,
    oapp: &OApp,
    call: Call<QuoteParam, MessagingFee>,
): MessagingFee {
    let (_param, fee) = oapp.confirm_quote(&config.oapp_cap, call);
    fee
}

// === Public-View ===

/// Returns true if an intent with the given ID has already been received.
///
/// * `config` - Shared LzReceiverConfig object.
/// * `intent_id` - 32-byte intent identifier.
public fun is_received(config: &LzReceiverConfig, intent_id: vector<u8>): bool {
    config.received_intents.contains(intent_id)
}

/// Returns the OApp CallCap ID. Used by the PTB builder for constructing
/// executor move calls.
///
/// * `config` - Shared LzReceiverConfig object.
public fun oapp_cap_id(config: &LzReceiverConfig): address {
    config.oapp_cap.id()
}

// === Admin ===

/// Registers this OApp with the LayerZero EndpointV2.
///
/// Must be called once after deployment so the endpoint knows how to route
/// messages to this OApp. Uses the internally stored CallCap.
///
/// * `config` - Shared LzReceiverConfig (provides the CallCap).
/// * `_oapp` - The OApp shared object.
/// * `endpoint` - Mutable reference to the LZ EndpointV2.
/// * `lz_receive_info` - OAppInfoV1-encoded metadata produced by `ptb_builder::lz_receive_info`.
entry fun register_oapp(
    config: &LzReceiverConfig,
    _oapp: &OApp,
    endpoint: &mut endpoint_v2::EndpointV2,
    lz_receive_info: vector<u8>,
    ctx: &mut TxContext,
) {
    endpoint_v2::register_oapp(endpoint, &config.oapp_cap, lz_receive_info, ctx);
}

/// Sets the authorized relayer address. Only the OApp admin can call this.
///
/// * `config` - Shared LzReceiverConfig to update.
/// * `admin_cap` - AdminCap proving the caller owns the OApp.
/// * `oapp` - The OApp shared object for admin verification.
/// * `new_relayer` - New relayer address. Must not be the zero address.
///
/// Aborts with `EZeroAddress` if `new_relayer` is `@0x0`.
entry fun set_relayer(
    config: &mut LzReceiverConfig,
    admin_cap: &AdminCap,
    oapp: &OApp,
    new_relayer: address,
) {
    oapp.assert_admin(admin_cap);
    assert!(new_relayer != @0x0, EZeroAddress);
    config.relayer = new_relayer;
}

// === Private ===

/// Extracts a contiguous byte slice from `data` starting at `start` with length `len`.
///
/// * `data` - Source byte vector.
/// * `start` - Zero-based starting index.
/// * `len` - Number of bytes to extract.
///
/// Aborts if `start + len` exceeds the length of `data`.
fun slice(data: &vector<u8>, start: u64, len: u64): vector<u8> {
    let mut result = vector::empty<u8>();
    let mut i = 0;
    while (i < len) {
        result.push_back(*data.borrow(start + i));
        i = i + 1;
    };
    result
}

/// Decodes a u64 from a 32-byte big-endian uint256 at the given offset.
///
/// Reads the last 8 bytes (offset+24..offset+32) as big-endian u64,
/// discarding the upper 24 bytes. Assumes the value fits in u64.
///
/// * `data` - Source byte vector containing the ABI-encoded uint256.
/// * `offset` - Byte offset where the 32-byte uint256 starts.
fun decode_u64_from_u256(data: &vector<u8>, offset: u64): u64 {
    let base = offset + 24;
    ((*data.borrow(base) as u64) << 56)
        | ((*data.borrow(base + 1) as u64) << 48)
        | ((*data.borrow(base + 2) as u64) << 40)
        | ((*data.borrow(base + 3) as u64) << 32)
        | ((*data.borrow(base + 4) as u64) << 24)
        | ((*data.borrow(base + 5) as u64) << 16)
        | ((*data.borrow(base + 6) as u64) << 8)
        | (*data.borrow(base + 7) as u64)
}

// === Test ===

/// Test-only initializer. Creates the OApp and LzReceiverConfig using a
/// synthetic one-time witness.
#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(LZ_RECEIVER {}, ctx);
}
