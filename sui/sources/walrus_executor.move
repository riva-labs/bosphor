module bosphor::walrus_executor {
    use sui::event;

    // --- Errors ---
    const ENotRelayer: u64 = 0;
    const EAlreadyExecuted: u64 = 1;

    // --- Types ---
    public struct ExecutorConfig has key {
        id: UID,
        relayer: address,
    }

    public struct StorageReceipt has key, store {
        id: UID,
        intent_id: vector<u8>,
        blob_id: vector<u8>,
        sender: address,
        timestamp: u64,
    }

    // --- Events ---
    public struct StorageExecuted has copy, drop {
        intent_id: vector<u8>,
        blob_id: vector<u8>,
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
        };
        let config_addr = config.id.to_address();
        transfer::share_object(config);
        event::emit(ConfigCreated {
            config_id: config_addr,
            relayer: ctx.sender(),
        });
    }

    // --- Core ---
    public entry fun execute_store(
        config: &ExecutorConfig,
        intent_id: vector<u8>,
        blob_id: vector<u8>,
        original_sender: address,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == config.relayer, ENotRelayer);

        let receipt = StorageReceipt {
            id: object::new(ctx),
            intent_id: intent_id,
            blob_id: blob_id,
            sender: original_sender,
            timestamp: 0, // tx timestamp handled by Sui runtime
        };

        event::emit(StorageExecuted {
            intent_id: receipt.intent_id,
            blob_id: receipt.blob_id,
            executor: ctx.sender(),
        });

        transfer::transfer(receipt, original_sender);
    }

    // --- Admin ---
    public entry fun update_relayer(
        config: &mut ExecutorConfig,
        new_relayer: address,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == config.relayer, ENotRelayer);
        config.relayer = new_relayer;
    }
}
