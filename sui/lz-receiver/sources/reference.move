/// Bosphor M3 Reference Verification
///
/// Pure predicates that decide whether a certified Walrus blob satisfies the
/// on-chain reference committed at intent time by `lz_receive`:
///   1. the blob id equals the committed blob id;
///   2. the blob's end epoch covers `current_epoch + committed_storage_epochs`.
///
/// This is the security-critical check that blocks content substitution and
/// storage under-funding. It lives here, alongside the module that records the
/// committed reference (`committed_blob_id` / `committed_storage_epochs`), and
/// intentionally takes plain scalars so it can be unit-tested without a
/// certified Walrus `Blob` or `System` object.
///
/// The executor package (`bosphor::walrus_executor`) applies these predicates to
/// a real `Blob` in `execute_store`. The executor package cannot run `sui move
/// test` on its own (its dependency graph mixes the LayerZero and Walrus Sui
/// framework revisions, which the Move test VM refuses to link), so the pure
/// verification logic is tested here, in a package the CI Move job already runs.
module bosphor_lz::reference;

/// Returns true when the certified blob id matches the committed reference.
///
/// * `committed_blob_id` - Blob id fixed at intent time by `lz_receive`.
/// * `actual_blob_id` - Blob id of the certified blob presented at execution.
public fun blob_id_matches(committed_blob_id: u256, actual_blob_id: u256): bool {
    actual_blob_id == committed_blob_id
}

/// Returns true when the blob's end epoch covers the committed storage duration.
///
/// The blob must remain available for at least `committed_storage_epochs` epochs
/// counting from the current epoch, i.e. `actual_end_epoch >= current_epoch +
/// committed_storage_epochs`. The sum is widened to `u64` to avoid `u32` overflow.
///
/// * `committed_storage_epochs` - Storage epochs the blob must remain available for.
/// * `actual_end_epoch` - End epoch of the certified blob.
/// * `current_epoch` - Current Walrus epoch.
public fun covers_storage_epochs(
    committed_storage_epochs: u32,
    actual_end_epoch: u32,
    current_epoch: u32,
): bool {
    (actual_end_epoch as u64) >= (current_epoch as u64) + (committed_storage_epochs as u64)
}
