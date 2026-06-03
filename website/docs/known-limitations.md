---
sidebar_position: 8
---

# Known Limitations

Current constraints and limitations of the Bosphor protocol as of Milestone 1.

## Single relayer trust model

The current architecture uses a single authorized relayer for both the Walrus executor and the LZ return path. This means:

- The relayer is a trusted operator. If the relayer goes offline, intents will not be fulfilled until it recovers.
- The relayer can choose not to fulfill an intent (censorship), though it cannot forge proofs due to DVN verification.
- There is no competition or fallback mechanism. A single relayer failure blocks all intent processing.

The roadmap includes a competing relayer model where multiple relayers can race to fulfill intents.

## Supported chains

- **EVM origin:** Sepolia testnet only. Mainnet deployment support exists but is not yet activated.
- **Storage destination:** Walrus on Sui testnet only.
- **Cross-chain messaging:** LayerZero v2 with a single DVN configuration.

Multi-chain EVM support (Arbitrum, Base, Optimism) is planned for Milestone 2. Solana origin support is planned for Milestone 3.

## Gas and fee limitations

- LZ messaging fees are estimated via `quoteLzFee` with a 10% buffer. In periods of high gas volatility, the buffer may be insufficient, causing the LZ send to fail. The relayer retries with updated fee quotes on failure.
- The relayer pays all LZ fees and Sui gas costs. There is no on-chain fee recovery mechanism from the intent sender. Fee sustainability depends on off-chain arrangements.
- The default LZ executor gas limit for `_lzReceive` on EVM is 200,000 gas, configured via LZ options. Complex `_lzReceive` handlers on EVM may require increasing this value.

## Deadline enforcement

- Intent deadlines are enforced in both directions: on the EVM adapter (`submitIntent` rejects expired deadlines) and on the Sui executor (`execute_store` checks the on-chain clock).
- There is a race window: an intent submitted close to its deadline may be accepted on EVM but expire before the relayer can execute it on Sui. The relayer skips expired intents rather than wasting gas.
- Deadlines use Unix timestamps in seconds (EVM) and milliseconds (Sui). The relayer converts between them.

## Walrus storage

- All blobs are stored as deletable. The relayer configures this at upload time. The protocol does not currently support permanent (non-deletable) storage.
- Blob storage duration is configured via `WALRUS_STORE_EPOCHS` (default: 5 epochs). There is no per-intent storage duration customization.
- If the Walrus publisher is unavailable, the relayer retries with exponential backoff up to 3 attempts. Persistent publisher outages block intent fulfillment.

## Object version conflicts on Sui

Consecutive Sui transactions that modify the same shared object (like `ExecutorConfig` or the LZ OApp) can fail with object version conflicts if submitted too quickly. The relayer uses `waitForTransaction` between consecutive transactions to avoid this, but under high throughput, sequential processing becomes a bottleneck.

## No on-chain intent cancellation

Once an intent is submitted on EVM, there is no mechanism for the sender to cancel it. The intent will either be fulfilled (if the relayer processes it before the deadline) or expire silently.

## Testnet vs. mainnet differences

- Testnet deployments use the LayerZero Labs DVN. Mainnet deployments may use different DVN configurations.
- Walrus testnet blob availability and durability guarantees differ from mainnet.
- Sui testnet may have different epoch durations and gas pricing than mainnet.
- The `EVM_DST_EID` config default targets Sepolia testnet (EID 40161). Mainnet requires changing this to the appropriate chain EID.

## Related

- [Architecture](architecture.md) for the system design
- [Relayer](relayer.md) for operational details and configuration
- [Deployment](deployment.md) for setup instructions
