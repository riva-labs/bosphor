# Changelog

## [0.1.0] — 2026-02-28

### Added
- **BosphorAdapter.sol** — EVM OApp contract (LayerZero v2)
  - `submitIntent` sends cross-chain messages via `_lzSend`
  - `_lzReceive` accepts proofs from remote chains
  - `confirmExecution` hybrid relayer path (backward-compatible)
  - `quote()` LZ fee estimation
- **walrus_executor.move** — Sui Move module
  - `execute_store` accepts real Walrus `Blob` object
  - On-chain blob_id/certified_epoch verification
- **lz_receiver.move** — Sui LZ OApp receiver
  - `lz_receive` processes incoming LZ messages
  - `IntentReceived` event for relayer polling
- **ptb_builder.move** — PTB builder for LZ executor
- **Relayer** (TypeScript)
  - Dual polling: Sui events (LZ) + EVM events (fallback)
  - Walrus upload → Sui execute_store → EVM confirmExecution
- **EndpointV2Mock** — minimal LZ endpoint mock for Forge tests

### Testnet Deployments
- **EVM (Sepolia)**: `0xd3aea854899938D48024a73E3289C3d29D6e2981`
- **EVM (Sepolia, old v0.1.0)**: `0x3EdcF291ade81640a079069a4d16f1dE4eAbfb74`
- **Sui walrus_executor**: `0x169f0ece587a5b54cf39218cdf5319ba7ecbb7d403b022802f1f329dbee3e596`
- **Sui LZ OApp (v1)**: `0xdd97dc32a0fc3e289a0de5c7c48ed493f3e62487f0a0abfbec41f98beb731dda`
