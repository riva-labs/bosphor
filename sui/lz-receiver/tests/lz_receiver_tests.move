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

// === build_proof_message tests ===

#[test]
fun test_build_proof_message_encoding() {
    // intent_id: 32 bytes, first byte 0xAA, rest zeros
    let mut intent_id = vector::empty<u8>();
    intent_id.push_back(0xAA);
    let mut i = 1u64;
    while (i < 32) { intent_id.push_back(0); i = i + 1; };

    // blob_id: 32 bytes, first byte 0xBB, rest zeros
    let mut blob_id = vector::empty<u8>();
    blob_id.push_back(0xBB);
    i = 1;
    while (i < 32) { blob_id.push_back(0); i = i + 1; };

    let end_epoch: u64 = 42;

    let msg = lz_receiver::build_proof_message(intent_id, blob_id, end_epoch);

    // Total length: 1 (type prefix) + 32 (intentId) + 32 (blobId) + 32 (endEpoch) = 97
    assert!(msg.length() == 97, 0);

    // First byte is type 1 prefix
    assert!(*msg.borrow(0) == 1, 1);

    // Bytes 1..33 are intent_id
    assert!(*msg.borrow(1) == 0xAA, 2);
    assert!(*msg.borrow(2) == 0, 3);

    // Bytes 33..65 are blob_id
    assert!(*msg.borrow(33) == 0xBB, 4);
    assert!(*msg.borrow(34) == 0, 5);

    // Bytes 65..97 are end_epoch as uint256 (big-endian, left-padded)
    // 42 = 0x2A, should be at the last byte (index 96)
    assert!(*msg.borrow(96) == 42, 6);
    // All padding bytes should be zero
    assert!(*msg.borrow(65) == 0, 7);
    assert!(*msg.borrow(88) == 0, 8);
}

#[test]
#[expected_failure(abort_code = lz_receiver::EInvalidIntentIdLength)]
fun test_build_proof_message_rejects_short_intent_id() {
    let intent_id = x"AABB"; // only 2 bytes
    let mut blob_id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { blob_id.push_back(0); i = i + 1; };
    lz_receiver::build_proof_message(intent_id, blob_id, 1);
}

#[test]
#[expected_failure(abort_code = lz_receiver::EInvalidBlobIdLength)]
fun test_build_proof_message_rejects_short_blob_id() {
    let mut intent_id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { intent_id.push_back(0); i = i + 1; };
    let blob_id = x"CCDD"; // only 2 bytes
    lz_receiver::build_proof_message(intent_id, blob_id, 1);
}
