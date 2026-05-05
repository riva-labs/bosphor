# Milestone 1 — On-Chain Evidence

## Full E2E Flow: EVM → LayerZero → Sui → Walrus → EVM

### Run 1 (2026-03-05 — full relayer flow)

| Step | Link |
|------|------|
| EVM Intent TX (Sepolia) | https://sepolia.etherscan.io/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c |
| LayerZero DELIVERED (1m 11s) | https://testnet.layerzeroscan.com/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c |
| Sui execute_store TX | https://suiscan.xyz/testnet/tx/3MmJ1nkJEzzmBV9uFFBKdgqJM9sZi3xajJQrZw91WVNW |
| Walrus Blob | https://aggregator.walrus-testnet.walrus.space/v1/blobs/rfj52maH_ZyCqaMVIfMOJLUtNnu8ZQ_y-8ZW3pUa63s |
| EVM Confirmation TX | https://sepolia.etherscan.io/tx/0x13243e35227e6f2a421381bd1b48191e8fee67a0169861b688861337d7a774f6 |

### Run 2 (2026-05-05 — native LZ executor delivery)

| Step | Link |
|------|------|
| EVM Intent TX (Sepolia) | https://sepolia.etherscan.io/tx/0xe480bf0c9cc28cb687752a53dac004719ce46a954eef50ff890009d08f772144 |
| LayerZero DELIVERED | https://testnet.layerzeroscan.com/tx/0xe480bf0c9cc28cb687752a53dac004719ce46a954eef50ff890009d08f772144 |
| Sui lz_receive TX | https://suiscan.xyz/testnet/tx/HReQ4PrQNpvQsekpWyL5TX477ZsoZUsmJfUA1RFawRvZ |

## Contracts

| Contract | Address |
|----------|---------|
| EVM BosphorAdapter (Sepolia) | `0xbC7EF2F021F517d871282C2bb512C741ad2958c3` |
| Sui LZ OApp (Testnet) | `0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656` |
| Sui OApp Object | `0x9631910c0bc687a74f0b99dd88d2f0033c393aa36735095de8cce67d5eeb27b0` |

## Test Results

- `forge test`: 17/17 passed
- E2E (LZ native executor): DELIVERED

## Verification Instructions

To independently verify each transaction:

1. **LZ Explorer**: Open the LayerZero link. Confirm `status: DELIVERED` and `destination: SUCCEEDED`.

2. **Sui TX (Run 1)**: Open SuiScan link for `3MmJ1nk...`. Look for `StorageExecuted` event with matching `intent_id` and `walrus_blob_id`.

3. **Walrus Blob**: Open the aggregator URL. The blob content should be downloadable. This confirms the data was stored on Walrus and is retrievable.

4. **EVM Confirmation (Run 1)**: Open Etherscan link for `0x13243e...`. Look for `IntentExecuted` event with matching `intentId` and proof containing `blobId` and `suiDigest`.

5. **Sui TX (Run 2)**: Open SuiScan link for `HReQ4Pr...`. Look for `IntentReceived` event emitted by `lz_receiver::lz_receive`, confirming native executor delivery.
