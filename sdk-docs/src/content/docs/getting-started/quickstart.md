---
title: Quickstart
description: From npm install to a verified cross-chain storage round-trip in one call.
---

This tutorial takes you from an empty project to a file stored on Walrus, with a
proof verified back on your origin chain. It uses the **EVM path against testnet**;
the [Solana guide](/guides/solana/) mirrors it step for step.

By the end you will have called `store()` once and read back a verified
`{ intentId, blobId, endEpoch }`.

## Before you start

You need:

- **Node.js 22+** (the SDK is ESM-only).
- A funded **Sepolia** wallet (testnet ETH from any faucet).
- The deployed testnet adapter address and the relayer URL (below).

## 1. Install

```bash
npm install @bosphor/sdk ethers @mysten/walrus @mysten/sui
```

`@bosphor/sdk` is the only hard dependency. `ethers` and the `@mysten/*` packages
are optional peers: `ethers` signs the intent and the `@mysten/*` pair computes the
Walrus blob id locally. Install only what your path needs.

## 2. Construct the client

```ts
import { ethers } from 'ethers';
import { BosphorEvmClient, type AdapterContract } from '@bosphor/sdk/evm';

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(ADAPTER_ADDRESS, ADAPTER_ABI, signer);

const client = new BosphorEvmClient({
  adapter: contract as unknown as AdapterContract,
  relayerUrl: 'https://api.bosphor.xyz/testnet',
  dstEid: 40378, // Sui testnet
});
```

The SDK never takes a private key. It takes an `ethers` contract bound to a
**signer**, so wallet integrations and sponsored transactions work unchanged.

## 3. Store a file in one call

```ts
const fileBytes = new TextEncoder().encode('hello, permanence');

const { intentId, blobId, endEpoch } = await client.store(fileBytes, { epochs: 5 });

console.log({ intentId, blobId, endEpoch });
```

`store()` runs the whole path and only resolves once every step is verified
against on-chain state:

```
encode -> quote -> submit -> upload -> awaitProof
```

- **encode** derives the Walrus blob id locally from the bytes (no SUI, no WAL).
- **quote** asks the adapter for the LayerZero fee.
- **submit** sends the intent on-chain (this is where your wallet signs).
- **upload** hands the raw bytes to the relayer out-of-band.
- **awaitProof** polls until the return proof lands back on the origin chain.

A round-trip normally completes in a couple of minutes.

## 4. Handle the two failure modes

Nothing is fabricated on error. The two you will actually hit:

```ts
import { ProofTimeoutError, RelayerUploadError } from '@bosphor/sdk/evm';

try {
  await client.store(fileBytes, { epochs: 5 });
} catch (e) {
  if (e instanceof RelayerUploadError) {
    // The relayer rejected the upload: e.status, e.reason, e.intentId.
  } else if (e instanceof ProofTimeoutError) {
    // Not executed yet, but the intent is on-chain: re-poll awaitProof(e.intentId).
  } else {
    throw e;
  }
}
```

See [Handle errors](/guides/errors/) for the full model.

## Next steps

- [Store from Solana](/guides/solana/) — the same one-line API from a Solana wallet.
- [Resume after a crash](/guides/resume/) — pick a flow back up without double-spending.
- [How routing works](/concepts/how-it-works/) — why the fee is flat and what the
  commitment contains.
