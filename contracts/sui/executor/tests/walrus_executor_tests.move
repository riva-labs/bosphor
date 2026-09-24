// NOTE: this suite needs `tests/linkage_shim.move` to run. The Move test VM in
// sui 1.69 only records packages that the root package's modules reference
// directly in its linkage table, so transitive-only packages (WAL, Call,
// EndpointV2, Utils, Zro, PtbMoveCall) would otherwise fail every test with
// `MISSING_DEPENDENCY` (code 1021). Constructing a certified Walrus `Blob` in a
// unit test from scratch is not possible (`Blob::new` is package-private), so
// the `execute_store` tests below go through the Walrus test-only surface:
// `system::new_for_testing` + `register_blob` + the test-only certification
// message. That surface lives in the gitignored `deps/walrus` snapshot, which
// must also carry the upstream `walrus::test_utils` module (see #359). The
// reference-verification predicates are additionally unit-tested as pure
// functions in `bosphor_lz::reference` and via `assert_reference` here.
#[test_only]
module bosphor::walrus_executor_tests {
    use sui::clock;
    use sui::coin;
    use sui::event;
    use sui::test_scenario;
    use call::call_cap;
    use oapp::oapp;
    use wal::wal::WAL;
    use walrus::blob::{Self, Blob};
    use walrus::encoding;
    use walrus::messages;
    use walrus::system::{Self, System};
    use bosphor_lz::lz_receiver::{Self, LzReceiverConfig};
    use bosphor::walrus_executor::{Self, ExecutorConfig, StorageReceipt};

    const RELAYER: address = @0xA;
    const USER: address = @0xB;
    const ATTACKER: address = @0xC;

    // execute_store fixture: a deletable RS2 blob stored for 3 epochs.
    const INTENT_ID: vector<u8> = x"1111111111111111111111111111111111111111111111111111111111111111";
    const ROOT_HASH: u256 = 0xABC;
    const RS2: u8 = 1;
    const BLOB_SIZE: u64 = 5_000_000;
    const STORAGE_EPOCHS: u32 = 3;
    const FROST: u64 = 1_000_000_000_000;
    /// Committed deadline in unix SECONDS, as carried by the commitment.
    const DEADLINE_S: u64 = 1_800_000_000;

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

    // === assert_deadline tests (pure, seconds vs milliseconds) ===

    #[test]
    fun test_assert_deadline_accepts_before_and_at_deadline() {
        walrus_executor::assert_deadline(DEADLINE_S * 1000 - 1, DEADLINE_S);
        // Exactly at the deadline boundary is still allowed.
        walrus_executor::assert_deadline(DEADLINE_S * 1000, DEADLINE_S);
    }

    #[test, expected_failure(abort_code = walrus_executor::EDeadlineExpired)]
    fun test_assert_deadline_rejects_one_ms_past() {
        walrus_executor::assert_deadline(DEADLINE_S * 1000 + 1, DEADLINE_S);
    }

    #[test]
    fun test_assert_deadline_scales_seconds_to_ms() {
        // The unit trap: the clock is in ms, the committed deadline in seconds.
        // A clock value numerically above the deadline (but only ~1.8e6 s after
        // the epoch) is long before the deadline once the deadline is scaled.
        walrus_executor::assert_deadline(DEADLINE_S + 1, DEADLINE_S);
    }

    #[test]
    fun test_assert_deadline_max_deadline_does_not_overflow() {
        walrus_executor::assert_deadline(18_446_744_073_709_551_615, 18_446_744_073_709_551_615);
    }

    // === execute_store tests (committed deadline, #374) ===

    /// Registers and certifies a deletable blob whose id and lifetime match the
    /// fixture commitment.
    fun certified_blob(system: &mut System, ctx: &mut TxContext): Blob {
        let mut payment = coin::mint_for_testing<WAL>(FROST, ctx);
        let storage_size = encoding::encoded_blob_length(BLOB_SIZE, RS2, system.n_shards());
        let storage = system.reserve_space(storage_size, STORAGE_EPOCHS, &mut payment, ctx);
        let blob_id = blob::derive_blob_id(ROOT_HASH, RS2, BLOB_SIZE);
        let mut blob = system.register_blob(
            storage,
            blob_id,
            ROOT_HASH,
            BLOB_SIZE,
            RS2,
            true,
            &mut payment,
            ctx,
        );
        let msg = messages::certified_deletable_blob_message_for_testing(blob_id, blob.object_id());
        blob::certify_with_certified_msg_for_testing(&mut blob, system.epoch(), msg);
        payment.burn_for_testing();
        blob
    }

    /// Runs `execute_store` as the relayer with the Sui clock at `now_ms`.
    /// When `record` is true the intent is first recorded in the receiver with
    /// `committed_deadline_s` as its committed deadline.
    fun run_execute_store(record: bool, committed_deadline_s: u64, now_ms: u64) {
        let mut scenario = test_scenario::begin(RELAYER);
        {
            walrus_executor::init_for_testing(scenario.ctx());
            lz_receiver::init_for_testing(scenario.ctx());
        };
        // Walrus's `system::new_for_testing` builds its inner state with
        // `tx_context::dummy()`, which resets the native test tx context (sender
        // becomes @0x0). Build the Walrus fixtures first, then open a fresh tx so
        // `execute_store` runs as the relayer.
        let mut system = system::new_for_testing(scenario.ctx());
        let blob = certified_blob(&mut system, scenario.ctx());
        scenario.next_tx(RELAYER);
        {
            let mut config = scenario.take_shared<ExecutorConfig>();
            let mut lz_config = scenario.take_shared<LzReceiverConfig>();
            if (record) {
                lz_receiver::record_intent_for_testing(
                    &mut lz_config,
                    INTENT_ID,
                    blob.blob_id(),
                    STORAGE_EPOCHS,
                    committed_deadline_s,
                    40161,
                    1,
                );
            };
            let mut clock = clock::create_for_testing(scenario.ctx());
            clock.set_for_testing(now_ms);

            walrus_executor::execute_store(
                &mut config,
                &lz_config,
                &system,
                INTENT_ID,
                blob,
                &clock,
                USER,
                scenario.ctx(),
            );
            assert!(walrus_executor::is_executed(&config, INTENT_ID));

            clock.destroy_for_testing();
            system.destroy_for_testing();
            test_scenario::return_shared(lz_config);
            test_scenario::return_shared(config);
        };
        // The blob and the receipt go to the original sender.
        scenario.next_tx(USER);
        {
            let receipt = scenario.take_from_sender<StorageReceipt>();
            let blob = scenario.take_from_sender<Blob>();
            scenario.return_to_sender(receipt);
            scenario.return_to_sender(blob);
        };
        scenario.end();
    }

    #[test]
    fun test_execute_store_committed_deadline_in_future_succeeds() {
        // One minute before the committed deadline.
        run_execute_store(true, DEADLINE_S, (DEADLINE_S - 60) * 1000);
    }

    #[test]
    fun test_execute_store_at_committed_deadline_succeeds() {
        run_execute_store(true, DEADLINE_S, DEADLINE_S * 1000);
    }

    // There is no relayer deadline argument anymore: before #374 a relayer could
    // pass a far-future `deadline_ms` and execute an intent past the deadline the
    // user committed. Now only the committed value is consulted, so a passed
    // committed deadline aborts regardless of what the relayer would like.
    #[test, expected_failure(abort_code = walrus_executor::EDeadlineExpired)]
    fun test_execute_store_committed_deadline_passed_aborts() {
        run_execute_store(true, DEADLINE_S, DEADLINE_S * 1000 + 1);
    }

    #[test, expected_failure(abort_code = lz_receiver::EIntentNotReceived)]
    fun test_execute_store_unknown_intent_aborts() {
        run_execute_store(false, DEADLINE_S, (DEADLINE_S - 60) * 1000);
    }
}
