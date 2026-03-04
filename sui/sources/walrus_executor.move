module bosphor::walrus_executor {
    use sui::event;
    use sui::table::{Self, Table};
    use sui::clock::Clock;
    use walrus::blob::Blob;

    // --- Errors ---
    const ENotRelayer: u64 = 0;
    const EBlobNotCertified: u64 = 1;
    const EIntentAlreadyExecuted: u64 = 2;
    const EDeadlineExpired: u64 = 3;

    // --- Types ---
    public struct ExecutorConfig has key {
        id: UID,
        relayer: address,
        executed_intents: Table<vector<u8>, bool>,
    }

    public struct StorageReceipt has key, store {
        id: UID,
        intent_id: vector<u8>,
        walrus_blob_id: u256,
        end_epoch: u32,
        sender: address,
    }

    // --- Events ---
    public struct StorageExecuted has copy, drop {
        intent_id: vector<u8>,
        walrus_blob_id: u256,
        end_epoch: u32,
        executor: address,
    }

    public struct ConfigCreated has copy, drop {
        config_id: address,
        relayer: address,
    }

    // --- Init ---
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
    public fun is_executed(config: &ExecutorConfig, intent_id: vector<u8>): bool {
        config.executed_intents.contains(intent_id)
    }

    // --- Admin ---
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
