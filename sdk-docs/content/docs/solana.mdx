---
title: Store from Solana
description: Submit a storage intent from a Solana wallet with the same one-line API.
---

The Solana path has the **same one-line API** as EVM. The only shape difference:
Solana has no separate `quote` step, so the LayerZero fee is passed as `nativeFee`
(lamports) on the submit instruction.

```
encode -> submit -> upload -> awaitProof
```

## One call

```ts
import { Connection, Keypair } from '@solana/web3.js';
import { BosphorSolanaClient, createDefaultSolanaChain } from '@bosphor/sdk/solana';

const connection = new Connection(RPC_URL, 'confirmed');

// Anchor-free: no IDL, no Program. `endpointAccounts` are the LayerZero send
// accounts assembled per the deployed LZ config; `computeUnitLimit` covers the
// endpoint CPI (the 200k default is not enough).
const chain = await createDefaultSolanaChain({
  connection,
  wallet: payer,
  endpointAccounts,
  computeUnitLimit: 400_000,
});

const client = new BosphorSolanaClient({
  chain,
  relayerUrl: 'https://api.bosphor.xyz/testnet',
  dstEid: 40378, // Sui testnet
  nativeFee: 20_000_000n, // declared upper bound; only the computed fee is charged
});

const { intentId, blobId, endEpoch } = await client.store(fileBytes, { epochs: 5 });
```

The canonical intent id is the **same keccak digest** as the EVM and Sui paths. The
backend derives it from the on-chain nonce and cross-checks it against the
`IntentSubmitted` event in the confirmed transaction.

## The chain seam

`BosphorSolanaClient` talks to the chain through a minimal structural interface,
`SolanaChain` (`submitIntent(fields)` and `readIntent(intentId)`). The default
backend loads `@solana/web3.js` via a lazy dynamic import, so a codec-only or
EVM-only consumer never pulls the Solana stack. Unit tests inject a fake `SolanaChain`.

## Reading the proof on-chain

The on-chain proof of record is the `IntentState` PDA (`[b"intent", intentId]`),
which `lz_receive` marks `executed` and stamps with the blob id and end epoch.
For CPI or off-chain readers:

```ts
import { decodeIntentState, readSolanaProof } from '@bosphor/sdk/solana';

const info = await connection.getAccountInfo(intentPda);
const { executed, blobId, endEpoch } = readSolanaProof(info!.data);
```

A runnable end-to-end script lives at `sdk/examples/store-file.solana.ts`.
