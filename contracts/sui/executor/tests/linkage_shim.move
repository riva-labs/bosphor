// Test-only linkage shim. The Move test VM in sui 1.69 builds the root
// package's linkage table from the packages its own modules reference
// directly, not from the full dependency graph. Packages that only appear
// transitively (WAL behind Walrus; Call, EndpointV2, Utils, Zro and
// PtbMoveCall behind bosphor_lz/OApp) never enter the linkage table, so
// `verify_package_no_cyclic_relationships` fails every test in this package
// with MISSING_DEPENDENCY (code 1021). Referencing one type from each of
// those packages here pulls them into the linkage table and lets the whole
// suite link and run. This module contains no logic and is never published.
#[test_only]
module bosphor::linkage_shim {
    use std::type_name;

    /// Touches one type from every transitive dependency package so the test
    /// VM records them in the root linkage table.
    public fun touch_transitive_deps() {
        let _ = type_name::with_defining_ids<wal::wal::WAL>();
        let _ = type_name::with_defining_ids<zro::zro::ZRO>();
        let _ = type_name::with_defining_ids<call::call_cap::CallCap>();
        let _ = type_name::with_defining_ids<utils::bytes32::Bytes32>();
        let _ = type_name::with_defining_ids<endpoint_v2::endpoint_v2::EndpointV2>();
        let _ = type_name::with_defining_ids<ptb_move_call::move_call::MoveCall>();
    }
}
