/// Bosphor Walrus Executor
///
/// Executes storage intents by verifying certified Walrus blobs, recording
/// execution, and transferring the blob and a receipt to the original sender.
/// All blobs are stored as deletable (enforced at upload time in the relayer).
///
/// The relayer calls `execute_store` after uploading data to Walrus and receiving
/// a certified blob. This module verifies certification, enforces deadlines,
/// prevents double-execution, and transfers ownership to the original sender.
module bosphor::walrus_executor;

use bosphor_lz::lz_receiver::LzReceiverConfig;
use bosphor_lz::reference;
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};
use walrus::blob::Blob;
use walrus::system::System;

// === Errors ===

/// Caller is not the authorized relayer.
const ENotRelayer: u64 = 0;
/// Blob has not been certified by Walrus storage nodes.
const EBlobNotCertified: u64 = 1;
/// Intent with this ID has already been executed.
const EIntentAlreadyExecuted: u64 = 2;
/// Current timestamp exceeds the intent deadline.
const EDeadlineExpired: u64 = 3;
/// Certified blob id does not match the committed reference from `lz_receive`.
const EBlobIdMismatch: u64 = 4;
/// Certified blob does not cover the committed number of storage epochs.
const EInsufficientStorageEpochs: u64 = 5;

// === Structs ===

/// Shared configuration for the executor.
///
/// Holds the authorized relayer address and a deduplication table tracking
/// which intents have been executed. Created once at module initialization.
public struct ExecutorConfig has key {
    id: UID,
    /// Address authorized to call `execute_store`.
    relayer: address,
    /// Deduplication table keyed by intent ID. Value is always `true`.
    executed_intents: Table<vector<u8>, bool>,
}

/// On-chain receipt proving a storage intent was fulfilled.
///
/// Transferred to the original sender along with the Walrus blob.
/// Can be used by downstream contracts or off-chain indexers as proof of execution.
public struct StorageReceipt has key, store {
    id: UID,
    /// Unique identifier of the executed storage intent.
    intent_id: vector<u8>,
    /// Walrus blob ID (content-addressed hash of the stored data).
    walrus_blob_id: u256,
    /// Walrus epoch at which the blob storage expires.
    end_epoch: u32,
    /// Address of the original intent sender on EVM (mapped to Sui address).
    sender: address,
}

// === Events ===

/// Emitted when a storage intent is successfully executed.
public struct StorageExecuted has copy, drop {
    /// Unique identifier of the executed storage intent.
    intent_id: vector<u8>,
    /// Walrus blob ID of the stored data.
    walrus_blob_id: u256,
    /// Walrus epoch at which the blob storage expires.
    end_epoch: u32,
    /// Address of the relayer that executed the intent.
    executor: address,
}

/// Emitted once at module initialization with the config and relayer addresses.
public struct ConfigCreated has copy, drop {
    /// Object ID of the newly created ExecutorConfig.
    config_id: address,
    /// Address of the initial relayer (the deployer).
    relayer: address,
}

// === Init ===

/// Module initializer. Creates and shares the ExecutorConfig with the deployer
/// set as the initial relayer. Emits a `ConfigCreated` event.
fun init(ctx: &mut TxContext) {
    let config = ExecutorConfig {
        id: object::new(ctx),
        relayer: ctx.sender(),
        executed_intents: table::new(ctx),
    };
    let config_addr = config.id.to_address();
    transfer::share_object(config);
    event::emit(ConfigCreated {
        config_id: config_addr,
        relayer: ctx.sender(),
    });
}

// === Public-Mutative ===

/// Executes a storage intent by verifying a certified Walrus blob against the
/// committed reference recorded at intent time, recording the execution, and
/// transferring the blob and a `StorageReceipt` to the original sender.
///
/// Beyond relayer auth, certification, dedup, and deadline, this asserts the
/// certified blob matches the on-chain commitment fixed by `lz_receive`:
///   1. the blob id equals the committed blob id (`EBlobIdMismatch`);
///   2. the blob's end epoch covers `current_epoch + committed_storage_epochs`
///      (`EInsufficientStorageEpochs`).
/// The committed values come from `lz_config`, not from relayer arguments.
///
/// * `config` - Shared ExecutorConfig (checks relayer authorization and dedup).
/// * `lz_config` - Shared LzReceiverConfig holding the committed reference for the intent.
/// * `system` - Walrus System object, used to read the current epoch.
/// * `intent_id` - Unique identifier of the storage intent.
/// * `blob` - Certified Walrus Blob object to be stored.
/// * `deadline_ms` - Intent deadline in milliseconds; execution must happen before this.
/// * `clock` - Sui Clock for timestamp verification.
/// * `original_sender` - Address that initiated the intent on EVM; receives the blob and receipt.
///
/// Aborts with `ENotRelayer` if the caller is not the authorized relayer.
/// Aborts with `EBlobNotCertified` if the blob has not been certified.
/// Aborts with `EIntentAlreadyExecuted` if this intent was already executed.
/// Aborts with `EDeadlineExpired` if the current time exceeds the deadline.
/// Aborts with `EBlobIdMismatch` if the blob id differs from the committed reference.
/// Aborts with `EInsufficientStorageEpochs` if the blob does not cover the committed epochs.
public fun execute_store(
    config: &mut ExecutorConfig,
    lz_config: &LzReceiverConfig,
    system: &System,
    intent_id: vector<u8>,
    blob: Blob,
    deadline_ms: u64,
    clock: &Clock,
    original_sender: address,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == config.relayer, ENotRelayer);
    assert!(blob.certified_epoch().is_some(), EBlobNotCertified);
    assert!(!config.executed_intents.contains(intent_id), EIntentAlreadyExecuted);
    assert!(clock.timestamp_ms() <= deadline_ms, EDeadlineExpired);

    // Verify the certified blob against the reference committed by `lz_receive`.
    let committed_id = bosphor_lz::lz_receiver::committed_blob_id(lz_config, intent_id);
    let committed_epochs = bosphor_lz::lz_receiver::committed_storage_epochs(lz_config, intent_id);
    assert_reference(
        committed_id,
        committed_epochs,
        blob.blob_id(),
        blob.end_epoch(),
        system.epoch(),
    );

    config.executed_intents.add(intent_id, true);

    let walrus_blob_id = blob.blob_id();
    let end_epoch = blob.end_epoch();

    event::emit(StorageExecuted {
        intent_id,
        walrus_blob_id,
        end_epoch,
        executor: ctx.sender(),
    });

    let receipt = StorageReceipt {
        id: object::new(ctx),
        intent_id,
        walrus_blob_id,
        end_epoch,
        sender: original_sender,
    };

    transfer::public_transfer(blob, original_sender);
    transfer::transfer(receipt, original_sender);
}

// === Public-View ===

/// Returns true if the intent with the given ID has already been executed.
///
/// * `config` - Shared ExecutorConfig.
/// * `intent_id` - Unique identifier of the intent to check.
public fun is_executed(config: &ExecutorConfig, intent_id: vector<u8>): bool {
    config.executed_intents.contains(intent_id)
}

/// Reference-verification orchestrator shared by `execute_store`.
///
/// Asserts that a certified Walrus blob matches the committed reference:
///   1. the actual blob id equals the committed blob id (`EBlobIdMismatch`);
///   2. the actual end epoch covers `current_epoch + committed_storage_epochs`
///      (`EInsufficientStorageEpochs`).
///
/// The two pure predicates live in `bosphor_lz::reference`, alongside the module
/// that records the committed reference, and are unit-tested there. They are kept
/// out of this package because the executor's dependency graph mixes the
/// LayerZero and Walrus Sui framework revisions, which the Move test VM refuses
/// to link (`MISSING_DEPENDENCY`), so nothing in this package can `sui move test`.
///
/// This wrapper maps each predicate to the executor's own abort code so the
/// on-chain failure semantics are unchanged. It takes plain scalars so callers
/// need not construct a certified Walrus Blob or System object.
///
/// * `committed_blob_id` - Blob id fixed at intent time by `lz_receive`.
/// * `committed_storage_epochs` - Storage epochs the blob must remain available for.
/// * `actual_blob_id` - Blob id of the certified blob.
/// * `actual_end_epoch` - End epoch of the certified blob.
/// * `current_epoch` - Current Walrus epoch.
///
/// Aborts with `EBlobIdMismatch` if the blob ids differ.
/// Aborts with `EInsufficientStorageEpochs` if the blob does not cover the committed epochs.
public fun assert_reference(
    committed_blob_id: u256,
    committed_storage_epochs: u32,
    actual_blob_id: u256,
    actual_end_epoch: u32,
    current_epoch: u32,
) {
    assert!(reference::blob_id_matches(committed_blob_id, actual_blob_id), EBlobIdMismatch);
    assert!(
        reference::covers_storage_epochs(committed_storage_epochs, actual_end_epoch, current_epoch),
        EInsufficientStorageEpochs,
    );
}

// === Admin ===

/// Updates the authorized relayer address. Only the current relayer can call this.
///
/// * `config` - Shared ExecutorConfig.
/// * `new_relayer` - Address of the new relayer.
///
/// Aborts with `ENotRelayer` if the caller is not the current relayer.
public fun update_relayer(
    config: &mut ExecutorConfig,
    new_relayer: address,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == config.relayer, ENotRelayer);
    config.relayer = new_relayer;
}

// === Test ===

/// Test-only initializer. Creates and shares the ExecutorConfig with the
/// transaction sender as the initial relayer.
#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx);
}
