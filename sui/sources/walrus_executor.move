module bosphor::walrus_executor {
    use sui::event;
    use walrus::blob::Blob;

    // --- Errors ---
    const ENotRelayer: u64 = 0;
    const EBlobNotCertified: u64 = 1;

    // --- Types ---
    public struct ExecutorConfig has key {
        id: UID,
        relayer: address,
    }

    public struct StorageReceipt has key, store {
        id: UID,
        intent_id: vector<u8>,    // EVM intent hash (32 bytes)
        walrus_blob_id: u256,     // real Walrus blob ID from certified Blob object
        end_epoch: u32,           // Walrus storage end epoch
        sender: address,          // original EVM sender (mapped)
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
        };
        let config_addr = config.id.to_address();
        transfer::share_object(config);
        event::emit(ConfigCreated {
            config_id: config_addr,
            relayer: ctx.sender(),
        });
    }

    // --- Core ---
    /// Called by the relayer after storing blob via Walrus.
    /// Accepts the real Walrus Blob object, reads blob_id from it,
    /// records on-chain, and transfers Blob to the original sender.
    public fun execute_store(
        config: &ExecutorConfig,
        intent_id: vector<u8>,
        blob: Blob,
        original_sender: address,
        ctx: &mut TxContext,
    ) {
        assert!(ctx.sender() == config.relayer, ENotRelayer);
        // Blob must be certified (has availability proof)
        assert!(blob.certified_epoch().is_some(), EBlobNotCertified);

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

        // Transfer Blob to original sender (they own their data)
        transfer::public_transfer(blob, original_sender);
        transfer::transfer(receipt, original_sender);
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
}
