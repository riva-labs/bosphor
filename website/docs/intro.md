---
slug: /
title: Introduction
---

import HomepageHero from '@site/src/components/HomepageHero';

<HomepageHero />

## What it does

1. **Commit**: The SDK computes the Walrus blob id locally from your bytes, and your origin contract (EVM or Solana) submits a compact **commitment**, the blob id, size, encoding, storage duration, and a deadline.
2. **Route**: LayerZero v2 delivers the commitment cross-chain to Sui, verified by DVNs. The file bytes go to the relayer **out-of-band** over HTTP, never through the bridge.
3. **Store**: The relayer stores the bytes on Walrus, and `execute_store` on Sui asserts the stored blob id and end epoch match the commitment.
4. **Prove**: A DVN-verified proof (blob id, end epoch) returns to the origin chain, which verifies the returned blob id equals the one it committed.

Both legs of the round-trip are trustless. The relayer triggers execution but cannot forge proofs or substitute the stored bytes. Because only the commitment crosses the bridge, the cross-chain fee is **flat regardless of file size**.

## Why Bosphor

EVM and Solana developers cannot use Walrus natively. Walrus lives on Sui, so storing data from another chain would otherwise require bridging, transaction construction on Sui, and proof management across chains. Bosphor handles all of this behind a single SDK call.

Without Bosphor, a developer would need to:

- Run a Sui wallet and manage SUI tokens
- Build and sign Sui transactions for Walrus blob uploads
- Implement their own cross-chain message verification
- Track storage proofs manually across two chains

With Bosphor, the developer calls `store()` from `@bosphor/sdk` on EVM or Solana and receives a verified result when the data is stored. The SDK guides and API reference live at **[sdk.bosphor.xyz](https://sdk.bosphor.xyz)**.

```ts
const { intentId, blobId, endEpoch } = await client.store(bytes, { epochs: 5 });
```

## Ecosystem

Bosphor connects several protocols:

- **[Walrus](https://www.walrus.xyz/)**: Decentralized storage on Sui. Bosphor stores intent data as Walrus blobs.
- **[LayerZero v2](https://layerzero.network/)**: Cross-chain messaging. Both message directions are DVN-verified.
- **[Sui](https://sui.io/)**: The execution layer where Walrus storage and proof generation happen.
- **Origin chains**: any EVM chain, and **Solana**, submit the same commitment over the same protocol.

## Current status

**Milestone 3 complete.** The protocol makes cross-chain cost independent of data size and adds a second origin ecosystem:

- **Reference commitments**: intents carry only a compact commitment (blob id, size, encoding, storage duration); the bytes travel out-of-band, so the cross-chain fee is flat regardless of file size.
- **EVM and Solana origins live**: both submit the same commitment over LayerZero, with a verified round-trip on each.
- **Unified TypeScript SDK** (`@bosphor/sdk`, published): one `store()` call for both EVM and Solana, with the blob id computed locally and the result verified on-chain. Docs at [sdk.bosphor.xyz](https://sdk.bosphor.xyz).
- **Reference dApp shipped** at [demo.bosphor.xyz](https://demo.bosphor.xyz): a permanence-focused UX that runs real EVM and Solana round-trips end to end.
- Sui-side assertions bind the stored blob id and end epoch to the commitment, so the relayer cannot substitute or under-fund the data.

Milestone 2 built on Sepolia + Sui Testnet with a verified bidirectional E2E flow, validated on Ethereum mainnet. Its infrastructure remains live: Prometheus + Grafana monitoring, a Kener status page at status.bosphor.xyz, a continuous canary, the public intent feed (`GET /public/intents`) at api.bosphor.xyz, Sentry, an on-demand chaos harness, and a self-operated LayerZero DVN.

## Next steps

- [SDK docs (sdk.bosphor.xyz)](https://sdk.bosphor.xyz): integrate Bosphor from EVM or Solana with `@bosphor/sdk`.
- [Quickstart](quickstart.md): Deploy and run the full pipeline in 15 minutes.
- [Architecture](architecture.md): Understand the system design and message flow.
- [Security Model](security-model.md): Review trust assumptions before integrating.
- [Contract Interface](contract-interface.md): Function signatures and code examples.
