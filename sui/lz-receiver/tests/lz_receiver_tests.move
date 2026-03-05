#[test_only]
module bosphor_lz::lz_receiver_tests;

use bosphor_lz::lz_receiver;
use sui::test_scenario;

const ADMIN: address = @0xA;

#[test]
fun test_init_creates_shared_config() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        lz_receiver::init_for_testing(scenario.ctx());
    };
    // Config should be a shared object after init
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<lz_receiver::LzReceiverConfig>();
        // Verify config exists and is_received returns false for unknown intent
        assert!(!lz_receiver::is_received(&config, b"unknown_intent_id_32bytes_pad00"), 0);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

#[test]
fun test_is_received_returns_false_for_unknown() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        lz_receiver::init_for_testing(scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        let config = scenario.take_shared<lz_receiver::LzReceiverConfig>();
        assert!(!lz_receiver::is_received(&config, x"0000000000000000000000000000000000000000000000000000000000000001"), 0);
        assert!(!lz_receiver::is_received(&config, vector::empty<u8>()), 1);
        test_scenario::return_shared(config);
    };
    scenario.end();
}

#[test]
fun test_admin_cap_transferred_to_sender() {
    let mut scenario = test_scenario::begin(ADMIN);
    {
        lz_receiver::init_for_testing(scenario.ctx());
    };
    scenario.next_tx(ADMIN);
    {
        // AdminCap should be owned by ADMIN
        let admin_cap = scenario.take_from_sender<oapp::oapp::AdminCap>();
        scenario.return_to_sender(admin_cap);
    };
    scenario.end();
}
