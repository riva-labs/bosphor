# Changelog

## [v0.1.0] — 2026-03-05

### Summary
First working proof-of-concept of Bosphor cross-chain storage intent routing.
Full E2E flow verified on testnet: EVM → LayerZero → Sui → Walrus → EVM.

### Added
- **BosphorAdapter.sol** — EVM OApp contract (LayerZero v2)
  - `submitIntent` — sends storage intent via LayerZero
  - `_lzReceive` — accepts proof from Sui
  - `confirmExecution` — relayer hybrid path
  - `quote()` — LZ fee estimation
- **lz_receiver.move** — Sui LZ OApp receiver
  - `lz_receive` — processes incoming LZ messages
  - `IntentReceived` event for relayer
  - `register_oapp` — OAppInfoV1-compatible endpoint registration
- **walrus_executor.move** — Sui Walrus executor
  - `execute_store` — stores blob on Walrus
- **ptb_builder.move** — PTB builder with OAppInfoV1 format
- **Relayer** (Node.js/TypeScript) — event-driven, Docker-ready
- **Deployment scripts** — automated deploy + wire + e2e test

### Key Fix
LZ executor requires `oapp_info_v1` format for OApp registration.
`ptb_builder::lz_receive_info` updated to use `oapp_info_v1::create().encode()`.

### Testnet Evidence

| Step | TX |
|------|----|
| EVM Intent | [0x223d...](https://sepolia.etherscan.io/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c) |
| LZ DELIVERED (1m 11s) | [LZ Explorer](https://testnet.layerzeroscan.com/tx/0x223d075c73facfa48bddce0e4316548924b40a0fd362ad3628b0a59ae5c1c40c) |
| Sui execute_store | [3MmJ1nk...](https://suiscan.xyz/testnet/tx/3MmJ1nkJEzzmBV9uFFBKdgqJM9sZi3xajJQrZw91WVNW) |
| Walrus blob | [rfj52maH...](https://aggregator.walrus-testnet.walrus.space/v1/blobs/rfj52maH_ZyCqaMVIfMOJLUtNnu8ZQ_y-8ZW3pUa63s) |
| EVM Confirmation | [0x13243e...](https://sepolia.etherscan.io/tx/0x13243e35227e6f2a421381bd1b48191e8fee67a0169861b688861337d7a774f6) |

### Testnet Deployments
- EVM (Sepolia): `0xbC7EF2F021F517d871282C2bb512C741ad2958c3`
- Sui LZ OApp: `0xa4420716d875fa323c5d543876d03979607dea3c428818566d25d82fea6f6656`
