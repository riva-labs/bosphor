#[test_only]
module bosphor_lz::lz_receiver_tests;

use bosphor_lz::codec;
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

// === codec::encode tests ===

#[test]
fun test_encode_proof_message() {
    // intent_id: 32 bytes, first byte 0xAA, rest zeros
    let mut intent_id = vector::empty<u8>();
    intent_id.push_back(0xAA);
    let mut i = 1u64;
    while (i < 32) { intent_id.push_back(0); i = i + 1; };

    // blob_id: 32 bytes, first byte 0xBB, rest zeros
    let mut blob_id = vector::empty<u8>();
    blob_id.push_back(0xBB);
    i = 1u64;
    while (i < 32) { blob_id.push_back(0); i = i + 1; };

    let end_epoch: u64 = 42;

    let msg = codec::encode(intent_id, blob_id, end_epoch);

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
#[expected_failure(abort_code = codec::EInvalidIntentIdLength)]
fun test_encode_rejects_short_intent_id() {
    let intent_id = x"AABB"; // only 2 bytes
    let mut blob_id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { blob_id.push_back(0); i = i + 1; };
    codec::encode(intent_id, blob_id, 1);
}

#[test]
#[expected_failure(abort_code = codec::EInvalidBlobIdLength)]
fun test_encode_rejects_short_blob_id() {
    let mut intent_id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { intent_id.push_back(0); i = i + 1; };
    let blob_id = x"CCDD"; // only 2 bytes
    codec::encode(intent_id, blob_id, 1);
}

// === codec round-trip tests ===

#[test]
fun test_codec_round_trip() {
    // Build known 32-byte intent_id (0x01 repeated)
    let mut intent_id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { intent_id.push_back(0x01); i = i + 1; };

    // Build known 32-byte blob_id (0xFF repeated)
    let mut blob_id = vector::empty<u8>();
    i = 0;
    while (i < 32) { blob_id.push_back(0xFF); i = i + 1; };

    let end_epoch: u64 = 12345;

    // Encode
    let msg = codec::encode(intent_id, blob_id, end_epoch);
    assert!(msg.length() == 97, 0);

    // Decode
    let (dec_intent_id, dec_blob_id, dec_end_epoch) = codec::decode(&msg);

    // Verify all fields match
    assert!(dec_intent_id == intent_id, 1);
    assert!(dec_blob_id == blob_id, 2);
    assert!(dec_end_epoch == end_epoch, 3);
}

#[test]
fun test_codec_round_trip_zero_epoch() {
    let mut intent_id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { intent_id.push_back(0xAB); i = i + 1; };

    let mut blob_id = vector::empty<u8>();
    i = 0;
    while (i < 32) { blob_id.push_back(0xCD); i = i + 1; };

    let msg = codec::encode(intent_id, blob_id, 0);
    let (dec_intent_id, dec_blob_id, dec_end_epoch) = codec::decode(&msg);

    assert!(dec_intent_id == intent_id, 0);
    assert!(dec_blob_id == blob_id, 1);
    assert!(dec_end_epoch == 0, 2);
}

#[test]
fun test_codec_round_trip_max_u64_epoch() {
    let mut intent_id = vector::empty<u8>();
    let mut i = 0u64;
    while (i < 32) { intent_id.push_back(0); i = i + 1; };

    let mut blob_id = vector::empty<u8>();
    i = 0;
    while (i < 32) { blob_id.push_back(0); i = i + 1; };

    let max_u64: u64 = 18446744073709551615;
    let msg = codec::encode(intent_id, blob_id, max_u64);
    let (_dec_intent_id, _dec_blob_id, dec_end_epoch) = codec::decode(&msg);

    assert!(dec_end_epoch == max_u64, 0);
}

#[test]
#[expected_failure(abort_code = codec::EInvalidMessageType)]
fun test_decode_rejects_wrong_type_prefix() {
    // Build a valid 97-byte message but with wrong type prefix (0x02)
    let mut msg = vector::empty<u8>();
    msg.push_back(0x02); // wrong prefix
    let mut i = 0u64;
    while (i < 96) { msg.push_back(0); i = i + 1; };
    codec::decode(&msg);
}

#[test]
#[expected_failure(abort_code = codec::EInvalidMessageLength)]
fun test_decode_rejects_short_message() {
    // Build a message shorter than 97 bytes
    let mut msg = vector::empty<u8>();
    msg.push_back(0x01);
    let mut i = 0u64;
    while (i < 50) { msg.push_back(0); i = i + 1; }; // only 51 bytes total
    codec::decode(&msg);
}

#[test]
#[expected_failure(abort_code = codec::EInvalidMessageLength)]
fun test_decode_rejects_long_message() {
    // Build a message longer than 97 bytes
    let mut msg = vector::empty<u8>();
    msg.push_back(0x01);
    let mut i = 0u64;
    while (i < 100) { msg.push_back(0); i = i + 1; }; // 101 bytes total
    codec::decode(&msg);
}
