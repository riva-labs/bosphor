---
title: Store from EVM
description: Submit a storage intent from an EVM wallet and drive the flow step by step.
---

The EVM client wraps an `ethers` contract bound to a signer. The one-call path is
in the [Quickstart](/getting-started/quickstart/); this guide covers the pieces you
reach for when you need more control.

## One call

```ts
import { BosphorEvmClient, type AdapterContract } from '@bosphor/sdk/evm';

const client = new BosphorEvmClient({
  adapter: contract as unknown as AdapterContract,
  relayerUrl: 'https://api.bosphor.xyz/testnet',
  dstEid: 40378,
});

const { intentId, blobId, endEpoch } = await client.store(fileBytes, { epochs: 5 });
```

## Drive the steps yourself

Every step `store()` orchestrates is public, so you can split signing across
separate user interactions (for wallet popups) or persist between steps:

```ts
const encoded = await client.encode(fileBytes, { epochs: 5 });
const fee = await client.quote(encoded);
const { intentId } = await client.submit(encoded, fee); // wallet signs here
await client.upload(intentId, fileBytes);
const { blobId, endEpoch } = await client.awaitProof(intentId, {
  timeoutMs: 300_000,
  pollMs: 3_000,
});
```

Splitting `submit` from later steps matters in the browser: a wallet popup must
open in direct response to a user gesture, so each signature belongs in its own
event handler.

## Blob-id computation

The Walrus blob id is derived locally from the bytes, so the id the SDK commits to
on-chain matches what the relayer recomputes on ingest. The default lazily loads
`@mysten/walrus` and is fixed to **testnet** shard parameters.

For **mainnet**, or to avoid the Walrus dependency, inject your own `computeBlob`:

```ts
const client = new BosphorEvmClient({
  adapter,
  relayerUrl,
  dstEid,
  computeBlob: async (data) => ({ blobId, size: data.length, encodingType: 0 }),
});
```

The injected function must return the same id the relayer computes for the same
bytes, or the on-chain reference check rejects the intent.

## Cancellation

Pass an `AbortSignal` to cancel the wait and the in-flight upload:

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(new Error('took too long')), 30_000);
await client.store(fileBytes, { epochs: 5, signal: ac.signal });
```

The on-chain intent is not rolled back. See [Resume after a crash](/guides/resume/).

A runnable end-to-end script lives at `sdk/examples/store-file.evm.ts`.
