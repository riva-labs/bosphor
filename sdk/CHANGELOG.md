# Changelog

## 0.11.0 (2026-08-31)

### Features

- feat(sdk): regenerate parity vectors as version-1 fixtures
- feat(sdk): version the commitment wire format (v1, 50 bytes)

## 0.10.0 (2026-08-30)

### Features

- feat(sdk): fromEthersContract factory, submit tx hash, and network-aware blob id

## 0.9.0 (2026-08-27)

### Features

- feat(sdk): add stable code and retryable to the error hierarchy

### Bug Fixes

- fix(sdk): make blob-id and event decoding Buffer-free

## 0.8.0 (2026-08-26)

### Features

- feat(sdk): add computeUnitLimit to default Solana backend

## 0.7.0 (2026-08-18)

### Features

- feat(sdk): AbortSignal cancellation for store/awaitProof/upload
- feat(sdk): typed BosphorError hierarchy + shared store-flow helpers

DX pass: publishable ESM build (dist), the error hierarchy exported from the core,
a DRY store-flow shared across chains, TypeDoc config + docs script, and standard
README sections (errors, API surface, cancellation, compatibility, versioning,
security, build).

## 0.6.0 (2026-08-18)

### Features

- feat(sdk): encode confirm_execution for the Solana adapter (#242)

## 0.5.2 (2026-08-15)

### Bug Fixes

- fix(sdk): encode the Walrus blob id big-endian in the commitment

## 0.5.1 (2026-08-14)

### Bug Fixes

- fix(sdk): repair defaultComputeBlob against @mysten/sui v2.24

## 0.5.0 (2026-08-14)

### Features

- feat(sdk): make the Solana path IDL-free (own the program binary interface)

## 0.4.0 (2026-08-14)

### Features

- feat(sdk): add @bosphor/sdk/solana subpath with one-call store()

## 0.3.0 (2026-08-11)

### Features

- feat(sdk): Unified SDK v2 EVM core with one-call store()

## 0.2.0 (2026-08-11)

### Features

- feat(sdk): freeze cross-chain commitment parity vectors
- feat(sdk): add CommitmentCodec reference implementation in TypeScript

