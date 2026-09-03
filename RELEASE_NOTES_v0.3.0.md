# v0.3.0: Multi-Chain Adapter & SDK Layer

Milestone 3 turns the single-origin, mainnet-proven execution core from Milestones 1
and 2 into a multi-chain platform with a published SDK, and removes the payload-size
cost limitation flagged at the end of Milestone 2. Solana is now a first-class origin
chain, the Unified SDK (`@bosphor/sdk`) is on npm, and a live reference dApp performs
real cross-chain stores through the SDK on both EVM and Solana.

## Component versions

| Component | Version | Changed in M3 |
|-----------|---------|---------------|
| contracts-evm | 0.4.0 | Yes (reference-based adapter) |
| sui | 0.4.1 | Yes (reference-based executor + lz-receiver + security-pass fixes) |
| relayer | 0.10.2 | Yes (durable queue, reference ingest, Solana leg, resilience fixes) |
| sdk | 0.10.0 | Yes (new: the Unified SDK, published to npm) |

## What is new

### Solana as a first-class origin chain
- Solana adapter program on devnet (`7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF`): submit a storage intent, receive a verified receipt natively, the same end-to-end capability EVM got in Milestone 1.
- The Sui-side execution and proof-return path are chain-agnostic, so Solana reuses the hardened core rather than duplicating it.
- A Solana devnet round-trip runs continuously alongside the EVM one under the synthetic canary.

### Unified SDK (`@bosphor/sdk`)
- Published on npm: https://www.npmjs.com/package/@bosphor/sdk
- One chain-agnostic store flow for both EVM and Solana; the SDK handles intent encoding, client-side blob-id derivation, upload, and proof polling.
- Standardized proofs verified on the origin chain through LayerZero, so an origin-chain contract confirms Walrus data natively rather than trusting a relayer event.
- A `BosphorError` hierarchy for programmatic error handling; CI-driven publishing.

### Cost decoupled from data size (the Milestone 2 limitation, removed)
- The cross-chain message now carries only a fixed 49-byte reference (blob id, size, encoding, storage epochs, deadline); the data goes straight to Walrus out-of-band.
- Cross-chain cost is roughly constant regardless of payload size; the only size-dependent cost left is Walrus storage itself, priced in WAL.
- The 49-byte commitment codec is implemented identically in Solidity, Move, Rust (Solana), and TypeScript, locked together by shared parity vectors so the four implementations cannot drift.

### Reference dApp
- Live at https://demo.bosphor.xyz: a Google-Drive-style permanent-storage app that performs real end-to-end cross-chain stores through the SDK on EVM (Sepolia) and Solana (devnet), the primary proof the SDK is usable by application code end-to-end.

## Validation & evidence

- **Tests:** Solidity (forge), Move (lz-receiver + executor), Rust commitment codec, SDK parity vectors, and the relayer suite (220+ Jest) all green in CI on every push, including byte-for-byte cross-language codec parity.
- **Deterministic proof validation:** the returned proof is verified on the origin chain through LayerZero, not trusted from the relayer; the trust-minimized `lz_send_proof` return path was proven end-to-end on testnet this milestone.
- **Continuous synthetic canary:** real round-trips on both EVM and Solana, exercised continuously; monitoring at https://grafana.bosphor.xyz and status at https://status.bosphor.xyz.
- **Security pass:** a structured Move security review of the lz-receiver and executor packages was run before the payment work of Milestone 4, with findings addressed.

## Deployment (M3 "v6" stack, testnet / devnet)
- EVM adapter (Sepolia): `0xe722b5D7e27F59daA03616Cc819503a9A200939c`
- Sui package: `0x7b237259414e164a294ba3723721f31253e3c94432b7fe1b5eff22ad03444e36`
- Solana program (devnet): `7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF`

## Known limitations carried into Milestone 4
- Return-leg settlement runs on the owner-gated `confirmExecution` fallback in production; the trust-minimized `lz_send_proof` path is proven on testnet and re-enabled once a continuous return-delivery worker is deployed. Both verify the same proof on the origin chain.
- The Milestone 3 stack is on testnet/devnet; the mainnet deployment is part of the Milestone 4 payment/launch work.
