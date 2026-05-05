/// Bosphor LayerZero OApp Receiver
///
/// Receives cross-chain intent messages from EVM via LayerZero v2.
/// The executor delivers messages through PTB, OApp validates peer + endpoint.
#[allow(lint(self_transfer))]
module bosphor_lz::lz_receiver;

use call::call::{Call, Void};
use call::call_cap::CallCap;
use endpoint_v2::endpoint_v2;
use endpoint_v2::lz_receive::LzReceiveParam;
use oapp::oapp::{Self, OApp};
use sui::event;
use sui::table::{Self, Table};
use utils::bytes32::Bytes32;

// === Errors ===

/// Intent with this ID was already received and recorded.
const EIntentAlreadyReceived: u64 = 0;
/// Message payload is shorter than the minimum 32 bytes (missing intent_id).
const EInvalidMessageLength: u64 = 1;

// === OTW ===

/// One-time witness for module initialization. Used to create the OApp.
public struct LZ_RECEIVER has drop {}

// === Structs ===

/// Shared config holding the OApp call capability and received intents
public struct LzReceiverConfig has key {
    id: UID,
    oapp_cap: CallCap,
    received_intents: Table<vector<u8>, IntentRecord>,
}

/// Record of a received intent
public struct IntentRecord has store {
    payload: vector<u8>,
    src_eid: u32,
    nonce: u64,
}

// === Events ===

/// Emitted when LZ delivers an intent from EVM
public struct IntentReceived has copy, drop {
    intent_id: vector<u8>,
    payload: vector<u8>,
    src_eid: u32,
    nonce: u64,
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
    };
    transfer::share_object(config);
    transfer::public_transfer(admin_cap, ctx.sender());
}

// === Core ===

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

// === View ===

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

// === Internal ===

/// Extracts a contiguous byte slice from `data` starting at `start` with length `len`.
fun slice(data: &vector<u8>, start: u64, len: u64): vector<u8> {
    let mut result = vector::empty<u8>();
    let mut i = 0;
    while (i < len) {
        result.push_back(*data.borrow(start + i));
        i = i + 1;
    };
    result
}

// === Test Helpers ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(LZ_RECEIVER {}, ctx);
}
