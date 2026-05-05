/// Bosphor Walrus Executor
///
/// Executes storage intents by verifying certified Walrus blobs, recording
/// execution, and transferring the blob and a receipt to the original sender.
/// All blobs are stored as deletable (enforced at upload time in the relayer).
module bosphor::walrus_executor {
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::Clock;
    use walrus::blob::Blob;

    // --- Errors ---

    /// Caller is not the authorized relayer.
    const ENotRelayer: u64 = 0;
    /// Blob has not been certified by Walrus storage nodes.
    const EBlobNotCertified: u64 = 1;
    /// Intent with this ID has already been executed.
    const EIntentAlreadyExecuted: u64 = 2;
    /// Current timestamp exceeds the intent deadline.
    const EDeadlineExpired: u64 = 3;

    // --- Types ---

    /// Shared configuration for the executor. Holds the authorized relayer address
    /// and a table tracking which intents have been executed.
    public struct ExecutorConfig has key {
        id: UID,
        relayer: address,
        executed_intents: Table<vector<u8>, bool>,
    }

    /// On-chain receipt proving a storage intent was fulfilled. Transferred to the
    /// original sender along with the Walrus blob.
    public struct StorageReceipt has key, store {
        id: UID,
        intent_id: vector<u8>,
        walrus_blob_id: u256,
        end_epoch: u32,
        sender: address,
    }

    // --- Events ---

    /// Emitted when a storage intent is successfully executed.
    public struct StorageExecuted has copy, drop {
        intent_id: vector<u8>,
        walrus_blob_id: u256,
        end_epoch: u32,
        executor: address,
    }

    /// Emitted once at module initialization with the config and relayer addresses.
    public struct ConfigCreated has copy, drop {
        config_id: address,
        relayer: address,
    }

    // --- Init ---

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

    // --- Core ---

    /// Executes a storage intent by verifying a certified Walrus blob, recording
    /// the execution, and transferring the blob and a `StorageReceipt` to the
    /// original sender.
    ///
    /// * `config` - Shared ExecutorConfig (checks relayer authorization and dedup).
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
    public fun execute_store(
        config: &mut ExecutorConfig,
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

    // --- View ---

    /// Returns true if the intent with the given ID has already been executed.
    ///
    /// * `config` - Shared ExecutorConfig.
    /// * `intent_id` - Unique identifier of the intent to check.
    public fun is_executed(config: &ExecutorConfig, intent_id: vector<u8>): bool {
        config.executed_intents.contains(intent_id)
    }

    // --- Admin ---

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

    // --- Testing ---
    #[test_only]
    public fun init_for_testing(ctx: &mut TxContext) {
        init(ctx);
    }
}
