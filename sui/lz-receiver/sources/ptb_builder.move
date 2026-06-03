/// Bosphor PTB Builder for LZ Executor
///
/// Generates execution metadata (`lz_receive_info`) for endpoint registration,
/// and builds Programmable Transaction Block (PTB) MoveCalls for the LayerZero
/// executor to deliver messages to this OApp.
///
/// This module is called in two contexts:
/// 1. At registration time, to produce OAppInfoV1-encoded metadata.
/// 2. At message delivery time (simulate mode), to produce the MoveCall sequence
///    the executor replays in the actual `lz_receive` transaction.
module bosphor_lz::ptb_builder;

use call::call::{Call, Void};
use endpoint_v2::lz_receive::LzReceiveParam;
use oapp::oapp::OApp;
use oapp::oapp_info_v1;
use oapp::ptb_builder_helper;
use bosphor_lz::lz_receiver::LzReceiverConfig;
use ptb_move_call::{argument, move_call::{Self, MoveCall}, move_calls_builder};
use sui::bcs;
use utils::{buffer_writer, package};

/// Marker struct for package address resolution after upgrades.
///
/// The LZ executor uses this type's package address to build MoveCalls.
/// After a contract upgrade, create a new marker struct and update `bosphor_package()`.
public struct BosphorPtbBuilder has drop {}

/// Generates OAppInfoV1-encoded execution metadata for OApp registration with
/// the LayerZero endpoint.
///
/// The returned bytes tell the LZ executor how to construct PTBs for delivering
/// messages to this OApp. Called once during `register_oapp`.
///
/// * `config` - Shared LzReceiverConfig (provides object ID for the MoveCall argument).
/// * `oapp` - The OApp shared object.
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
    let lz_receive_bytes = bcs::to_bytes(&lz_receive_move_calls);
    let mut lz_writer = buffer_writer::new();
    lz_writer.write_u16(1).write_bytes(lz_receive_bytes);
    let lz_receive_info = lz_writer.to_bytes();

    let oapp_info = oapp_info_v1::create(
        object::id_address(oapp),
        vector::empty<u8>(), // next_nonce_info (not used)
        lz_receive_info,
        vector::empty<u8>(), // extra_info
    );
    oapp_info.encode()
}

/// Dynamically builds a PTB for processing incoming LayerZero messages.
///
/// Called by the executor in simulate mode. Returns a vector of `MoveCall`
/// entries that the executor replays in the actual lz_receive transaction.
///
/// * `config` - Shared LzReceiverConfig (provides object ID for the MoveCall argument).
/// * `oapp` - The OApp shared object.
/// * `_call` - Reference to the hot-potato Call (consumed by `lz_receive`, not here).
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

/// Returns the current package address by resolving `BosphorPtbBuilder`'s type info.
///
/// Must be updated after a contract upgrade by changing the marker type
/// passed to `package::package_of_type`.
fun bosphor_package(): address {
    package::package_of_type<BosphorPtbBuilder>()
}
