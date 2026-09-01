// NOTE: this suite needs `tests/linkage_shim.move` to run. The Move test VM in
// sui 1.69 only records packages that the root package's modules reference
// directly in its linkage table, so transitive-only packages (WAL, Call,
// EndpointV2, Utils, Zro, PtbMoveCall) would otherwise fail every test with
// `MISSING_DEPENDENCY` (code 1021). Constructing a certified Walrus `Blob` in a
// unit test remains infeasible, so the reference-verification predicates that
// `execute_store` applies are unit-tested as pure functions in
// `bosphor_lz::reference` (see contracts/sui/lz-receiver) and exercised here
// through the scalar `assert_reference` wrapper.
#[test_only]
module bosphor::walrus_executor_tests {
    use sui::event;
    use sui::test_scenario;
    use call::call_cap;
    use oapp::oapp;
    use bosphor::walrus_executor::{Self, ExecutorConfig};

    const RELAYER: address = @0xA;
    const USER: address = @0xB;
    const ATTACKER: address = @0xC;

    #[test]
    fun test_init_creates_shared_config() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let config = scenario.take_shared<ExecutorConfig>();
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    #[test]
    fun test_update_relayer_success() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            walrus_executor::update_relayer(&mut config, USER, scenario.ctx());
            test_scenario::return_shared(config);
        };
        // Verify new relayer can also update
        scenario.next_tx(USER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            walrus_executor::update_relayer(&mut config, RELAYER, scenario.ctx());
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    #[test, expected_failure(abort_code = walrus_executor::ENotRelayer)]
    fun test_update_relayer_unauthorized_fails() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(ATTACKER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            walrus_executor::update_relayer(&mut config, ATTACKER, scenario.ctx());
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    // === set_relayer (AdminCap-gated) tests ===

    #[test]
    fun test_set_relayer_updates_relayer_and_emits_event() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            let call_cap = call_cap::new_individual_cap(scenario.ctx());
            let admin_cap = oapp::create_admin_cap_for_test(scenario.ctx());
            let oapp_obj = oapp::create_oapp_for_test(&call_cap, &admin_cap, scenario.ctx());

            walrus_executor::set_relayer_for_testing(&mut config, &admin_cap, &oapp_obj, USER);

            let events = event::events_by_type<walrus_executor::RelayerChanged>();
            assert!(events.length() == 1, 0);
            let (old_relayer, new_relayer) =
                walrus_executor::relayer_changed_fields(events.borrow(0));
            assert!(old_relayer == RELAYER, 1);
            assert!(new_relayer == USER, 2);

            oapp::share_oapp_for_test(oapp_obj);
            transfer::public_transfer(call_cap, RELAYER);
            transfer::public_transfer(admin_cap, RELAYER);
            test_scenario::return_shared(config);
        };
        // The stored relayer is now USER: only USER may call update_relayer.
        scenario.next_tx(USER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            walrus_executor::update_relayer(&mut config, RELAYER, scenario.ctx());
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    #[test, expected_failure(abort_code = oapp::EInvalidAdminCap)]
    fun test_set_relayer_wrong_admin_cap_fails() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(ATTACKER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            let call_cap = call_cap::new_individual_cap(scenario.ctx());
            let admin_cap = oapp::create_admin_cap_for_test(scenario.ctx());
            let oapp_obj = oapp::create_oapp_for_test(&call_cap, &admin_cap, scenario.ctx());
            // A second cap that does not match the OApp's registered admin cap.
            let wrong_cap = oapp::create_admin_cap_for_test(scenario.ctx());

            walrus_executor::set_relayer_for_testing(&mut config, &wrong_cap, &oapp_obj, ATTACKER);

            oapp::share_oapp_for_test(oapp_obj);
            transfer::public_transfer(call_cap, ATTACKER);
            transfer::public_transfer(admin_cap, ATTACKER);
            transfer::public_transfer(wrong_cap, ATTACKER);
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    #[test, expected_failure(abort_code = walrus_executor::EZeroAddress)]
    fun test_set_relayer_zero_address_fails() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            let call_cap = call_cap::new_individual_cap(scenario.ctx());
            let admin_cap = oapp::create_admin_cap_for_test(scenario.ctx());
            let oapp_obj = oapp::create_oapp_for_test(&call_cap, &admin_cap, scenario.ctx());

            walrus_executor::set_relayer_for_testing(&mut config, &admin_cap, &oapp_obj, @0x0);

            oapp::share_oapp_for_test(oapp_obj);
            transfer::public_transfer(call_cap, RELAYER);
            transfer::public_transfer(admin_cap, RELAYER);
            test_scenario::return_shared(config);
        };
        scenario.end();
    }

    // === assert_reference tests (pure, no Blob/System) ===

    #[test]
    fun test_assert_reference_accepts_matching_blob_and_epochs() {
        // end_epoch exactly current + committed epochs.
        walrus_executor::assert_reference(
            0xABCDEF,
            10,
            0xABCDEF,
            110,
            100,
        );
        // end_epoch comfortably above the minimum.
        walrus_executor::assert_reference(
            0xABCDEF,
            10,
            0xABCDEF,
            500,
            100,
        );
    }

    #[test, expected_failure(abort_code = walrus_executor::EBlobIdMismatch)]
    fun test_assert_reference_rejects_wrong_blob_id() {
        walrus_executor::assert_reference(
            0xABCDEF,
            10,
            0x123456,
            500,
            100,
        );
    }

    #[test, expected_failure(abort_code = walrus_executor::EInsufficientStorageEpochs)]
    fun test_assert_reference_rejects_insufficient_epochs() {
        // end_epoch one below current + committed epochs (109 < 110).
        walrus_executor::assert_reference(
            0xABCDEF,
            10,
            0xABCDEF,
            109,
            100,
        );
    }

    #[test]
    fun test_is_executed_returns_false_for_new_intent() {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
        };
        scenario.next_tx(RELAYER);
        {
            let config = scenario.take_shared<ExecutorConfig>();
            assert!(!walrus_executor::is_executed(&config, b"some_intent_id"));
            test_scenario::return_shared(config);
        };
        scenario.end();
    }
}
