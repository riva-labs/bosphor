/// Bosphor PTB Builder for LZ Executor
///
/// Generates execution metadata (lz_receive_info) for endpoint registration,
/// and builds PTB MoveCalls for the executor to deliver messages.
module bosphor_lz::ptb_builder;

use call::call::{Call, Void};
use endpoint_v2::lz_receive::LzReceiveParam;
use oapp::oapp::OApp;
use oapp::ptb_builder_helper;
use bosphor_lz::lz_receiver::LzReceiverConfig;
use ptb_move_call::{argument, move_call::{Self, MoveCall}, move_calls_builder};
use sui::bcs;
use utils::{buffer_writer, package};

/// Version identifier for lz_receive_info format
const LZ_RECEIVE_INFO_VERSION_1: u16 = 1;

/// Struct for package address resolution after upgrades.
/// If upgrading, create a new struct and update bosphor_package().
public struct BosphorPtbBuilder has drop {}

/// Generates execution metadata for OApp registration with LayerZero endpoint.
///
/// Returns serialized info that tells the executor how to build PTBs for this OApp.
/// Called once during registration (register_oapp).
public fun lz_receive_info(
    config: &LzReceiverConfig,
    oapp: &OApp,
): vector<u8> {
    let lz_receive_move_calls = vector[
        move_call::create(
            bosphor_package(),
            b"ptb_builder".to_ascii_string(),
            b"build_lz_receive_ptb".to_ascii_string(),
            vector[
                argument::create_object(object::id_address(config)),
                argument::create_object(object::id_address(oapp)),
                argument::create_id(ptb_builder_helper::lz_receive_call_id()),
            ],
            vector[],
            true,
            vector[],
        ),
    ];
    let move_calls_bytes = bcs::to_bytes(&lz_receive_move_calls);
    let mut writer = buffer_writer::new();
    writer.write_u16(LZ_RECEIVE_INFO_VERSION_1).write_bytes(move_calls_bytes);
    writer.to_bytes()
}

/// Dynamically builds a PTB for processing incoming LayerZero messages.
///
/// Called by executor in simulate mode. Returns MoveCall(s) for actual lz_receive execution.
public fun build_lz_receive_ptb(
    config: &LzReceiverConfig,
    oapp: &OApp,
    _call: &Call<LzReceiveParam, Void>,
): vector<MoveCall> {
    let mut builder = move_calls_builder::new();
    let oapp_object = object::id_address(oapp);
    builder.add(
        move_call::create(
            bosphor_package(),
            b"lz_receiver".to_ascii_string(),
            b"lz_receive".to_ascii_string(),
            vector[
                argument::create_object(object::id_address(config)),
                argument::create_object(oapp_object),
                argument::create_id(ptb_builder_helper::lz_receive_call_id()),
            ],
            vector[],
            false,
            vector[],
        ),
    );
    builder.build()
}

/// Returns the current package address. Update this after contract upgrades.
fun bosphor_package(): address {
    package::package_of_type<BosphorPtbBuilder>()
}
