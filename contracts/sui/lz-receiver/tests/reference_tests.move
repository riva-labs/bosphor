#[test_only]
module bosphor_lz::reference_tests;

use bosphor_lz::reference;

// === blob_id_matches ===

#[test]
fun test_blob_id_matches_accepts_equal_ids() {
    assert!(reference::blob_id_matches(0xABCDEF, 0xABCDEF), 0);
    // Boundary values.
    assert!(reference::blob_id_matches(0, 0), 1);
    assert!(
        reference::blob_id_matches(
            0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF,
            0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF,
        ),
        2,
    );
}

#[test]
fun test_blob_id_matches_rejects_different_ids() {
    assert!(!reference::blob_id_matches(0xABCDEF, 0x123456), 0);
    // A single-bit difference must be rejected.
    assert!(!reference::blob_id_matches(0xABCDEF, 0xABCDEE), 1);
}

// === covers_storage_epochs ===

#[test]
fun test_covers_storage_epochs_accepts_exact_boundary() {
    // end_epoch exactly current + committed epochs (100 + 10 == 110).
    assert!(reference::covers_storage_epochs(10, 110, 100), 0);
}

#[test]
fun test_covers_storage_epochs_accepts_comfortable_margin() {
    assert!(reference::covers_storage_epochs(10, 500, 100), 0);
}

#[test]
fun test_covers_storage_epochs_rejects_one_below_boundary() {
    // end_epoch one below current + committed epochs (109 < 110).
    assert!(!reference::covers_storage_epochs(10, 109, 100), 0);
}

#[test]
fun test_covers_storage_epochs_zero_duration_needs_current_epoch() {
    // With zero committed epochs the blob only needs to reach the current epoch.
    assert!(reference::covers_storage_epochs(0, 100, 100), 0);
    assert!(!reference::covers_storage_epochs(0, 99, 100), 1);
}

#[test]
fun test_covers_storage_epochs_does_not_overflow_u32() {
    // current + committed exceeds u32::MAX; the u64 widening must not wrap.
    let u32_max: u32 = 4294967295;
    assert!(!reference::covers_storage_epochs(u32_max, u32_max, u32_max), 0);
    // A blob that genuinely covers the widened sum is accepted.
    assert!(reference::covers_storage_epochs(1, u32_max, u32_max - 1), 1);
}
