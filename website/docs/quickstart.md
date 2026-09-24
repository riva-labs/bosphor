---
sidebar_position: 2
title: Quickstart
---

# Quickstart

Store a file on Walrus from an Ethereum Sepolia or Solana devnet wallet, and get a
verified proof back on the chain you started from. You use the hosted Bosphor
testnet, so there is nothing to deploy: install the SDK, fund a wallet, and call
one function. Plan on about 15 minutes, most of it waiting for faucets.

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';
import AgentPrompt from '@site/src/components/AgentPrompt';

<AgentPrompt prompt="Create a new Node.js 22 TypeScript project that stores a file on Walrus through the hosted Bosphor testnet. Install @bosphor/sdk with ethers, @mysten/walrus and @mysten/sui. Build the client with createBosphorClientFromSigner(signer) from @bosphor/sdk/evm (it defaults to the TESTNET preset), print the priced quote with client.priceQuote, then call client.storePriced(bytes, { epochs: 5 }) and print the intentId, blobId, endEpoch, the Sepolia Etherscan link for txHash, and walrusBlobUrl(blobId). Read the Sepolia RPC URL and private key from environment variables." />

:::tip Want to run the whole protocol yourself?
This page is the integrator path against the hosted testnet. To deploy your own
contracts and relayer, see [Self-hosting](self-hosting.md).
:::

## What happens when you store

1. The SDK computes the Walrus blob id of your file locally.
2. Your wallet submits a small **intent** (the blob id, size, and storage terms) to
   the Bosphor adapter on your chain, and pays for it.
3. LayerZero carries the intent to Sui. The relayer receives your file bytes over
   HTTPS, checks them against the intent, and stores them on Walrus.
4. A proof travels back over LayerZero and marks the intent as executed on your
   chain. The SDK resolves with `{ intentId, blobId, endEpoch, txHash }`.

A round trip usually takes one to three minutes.

## 1. Prerequisites

- **Node.js 22 or newer.** The SDK is ESM only.
- **A wallet on the origin chain**, funded as below.
- **An RPC endpoint.** Public ones work for a first try; use your own (Alchemy,
  Infura, Helius, QuickNode) for anything more.

Every deployment value (adapter address, program id, endpoint ids, relayer URL)
ships in the SDK as the `TESTNET` preset, and is listed on the
[testnet reference](https://sdk.bosphor.xyz/docs/reference/testnet). You do not
need to copy any of them.

### Fund your wallet

A paid store costs the storage price plus the LayerZero messaging fee. At current
testnet prices, storing a 1 KB file for 5 epochs costs roughly:

| Origin | Cost per store (1 KB, 5 epochs) | Get test funds | Suggested balance |
|--------|---------------------------------|----------------|-------------------|
| Ethereum Sepolia | about 0.0015 ETH, plus gas | [Alchemy](https://www.alchemy.com/faucets/ethereum-sepolia) or [Google Cloud](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) faucet | 0.02 ETH |
| Solana devnet | about 0.035 SOL, including account rent | [faucet.solana.com](https://faucet.solana.com) or `solana airdrop 1 --url devnet` | 0.5 SOL |

Prices follow the live token prices. Ask the relayer for a live quote at any time
(`sizeBytes` is your file size, `originToken` is `ETH` or `SOL`):

```bash
curl -s -X POST https://api.bosphor.xyz/testnet/quote \
  -H 'content-type: application/json' \
  -d '{"sizeBytes":1024,"epochs":5,"originToken":"ETH"}'
```

`totalNative` in the response is the storage part in wei (or lamports for `SOL`).
The SDK adds the LayerZero fee for you when you call `priceQuote()`.

## 2. Install

<Tabs groupId="origin-chain">
<TabItem value="evm" label="EVM (Sepolia)">

```bash
npm install @bosphor/sdk ethers @mysten/walrus @mysten/sui
```

</TabItem>
<TabItem value="solana" label="Solana (devnet)">

```bash
npm install @bosphor/sdk @solana/web3.js @mysten/walrus @mysten/sui
```

</TabItem>
</Tabs>

`ethers` or `@solana/web3.js` signs the intent. `@mysten/walrus` and
`@mysten/sui` compute the Walrus blob id locally; they make no network call and
need no SUI or WAL.

## 3. Create a client

<Tabs groupId="origin-chain">
<TabItem value="evm" label="EVM (Sepolia)">

```ts title="client.ts"
import { ethers } from "ethers";
import { createBosphorClientFromSigner } from "@bosphor/sdk/evm";

const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

// Uses the TESTNET preset: adapter address, ABI, relayer URL, LayerZero options.
export const client = await createBosphorClientFromSigner(signer);
```

Any `ethers` v6 signer works, including a browser wallet
(`await new ethers.BrowserProvider(window.ethereum).getSigner()`).

</TabItem>
<TabItem value="solana" label="Solana (devnet)">

```ts title="client.ts"
import { readFileSync } from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { TESTNET, createBosphorSolanaClientFromKeypair } from "@bosphor/sdk/solana";

const connection = new Connection(process.env.SOLANA_RPC_URL ?? TESTNET.solana.rpcUrl, "confirmed");
const secret = JSON.parse(readFileSync(process.env.KEYPAIR!, "utf8")) as number[];
const wallet = Keypair.fromSecretKey(Uint8Array.from(secret));

// Uses the TESTNET preset: program id, LayerZero accounts, fee cap, relayer URL.
export const client = await createBosphorSolanaClientFromKeypair({ connection, wallet });
```

</TabItem>
</Tabs>

## 4. Check the price

`priceQuote()` returns the single amount you will pay and a USD breakdown, so you
can show it to your user before they sign.

```ts
const bytes = new TextEncoder().encode("hello, permanence");

const encoded = await client.encode(bytes, { epochs: 5 });
const quote = await client.priceQuote(encoded);

console.log(quote.totalNative);          // wei (EVM) or lamports (Solana)
console.log(quote.breakdown.totalUsd);   // the same amount in USD
```

## 5. Store the file

`storePriced()` quotes, pays, submits the intent, uploads the bytes to the relayer,
and waits for the proof, in one call. Your payment is held in escrow on your chain
and released to the relayer only when the proof arrives. If no proof arrives
before the intent deadline, the escrow can be refunded to you. See
[Payment flow](payment-flow.md).

```ts
const { intentId, blobId, endEpoch, txHash, quote } = await client.storePriced(bytes, {
  epochs: 5,
});

console.log({ intentId, blobId, endEpoch, txHash, paid: quote.totalNative });
```

`epochs` is how long Walrus keeps the file (one Walrus testnet epoch is one day).
`endEpoch` is the Walrus epoch at which the storage expires.

:::note Free stores on testnet
`client.store(bytes, { epochs })` runs the same flow but pays only the LayerZero
fee, with no escrow. The hosted testnet relayer accepts these today so you can
experiment cheaply. Build against `storePriced()`: it is the path paid storage
uses.
:::

## 6. Verify the result

Nothing in the result is taken on trust: `storePriced()` only resolves once the
intent is marked executed on your chain and the committed blob id matches. You can
check every step yourself.

<Tabs groupId="origin-chain">
<TabItem value="evm" label="EVM (Sepolia)">

```ts
import { TESTNET, walrusBlobUrl } from "@bosphor/sdk/evm";

console.log(`${TESTNET.evm.explorerUrl}/tx/${txHash}`);              // Etherscan
console.log(`${TESTNET.layerZeroScanUrl}/tx/${txHash}`);             // LayerZero Scan
console.log(walrusBlobUrl(blobId));                                  // Walrus aggregator
```

- **Etherscan** shows your `submitIntent` transaction and its `IntentSubmitted`
  event. The adapter's events tab later shows `IntentExecuted` for your intent id.
- **LayerZero Scan** shows the message to Sui as `Delivered`.
- **The Walrus aggregator** URL downloads your file.

</TabItem>
<TabItem value="solana" label="Solana (devnet)">

```ts
import { TESTNET, walrusBlobUrl } from "@bosphor/sdk/solana";

console.log(`https://solscan.io/tx/${txHash}?cluster=devnet`);       // Solscan
console.log(`${TESTNET.layerZeroScanUrl}/tx/${txHash}`);             // LayerZero Scan
console.log(walrusBlobUrl(blobId));                                  // Walrus aggregator
```

- **Solscan** shows your `submit_intent` transaction.
- **LayerZero Scan** shows the message to Sui as `Delivered`.
- **The Walrus aggregator** URL downloads your file.

</TabItem>
</Tabs>

The relayer's public feed shows each hop of recent intents (submitted, received,
stored on Walrus, recorded on Sui, proof sent, confirmed):

```bash
curl -s "https://api.bosphor.xyz/testnet/public/intents?limit=5"
```

## 7. Handle failures

Every failure throws a typed error. The two you are likely to see:

```ts
import { ProofTimeoutError, RelayerUploadError } from "@bosphor/sdk";

try {
  await client.storePriced(bytes, { epochs: 5 });
} catch (e) {
  if (e instanceof ProofTimeoutError) {
    // The intent is on-chain; the proof has not landed yet. Poll again:
    await client.awaitProof(e.intentId);
  } else if (e instanceof RelayerUploadError) {
    // The relayer refused the bytes: e.status and e.reason explain why.
  } else {
    throw e;
  }
}
```

A timeout is not a loss: the intent and your escrow are on-chain, and the flow
can be resumed. See [Troubleshooting](troubleshooting.md) and the SDK guide to
[resuming after a crash](https://sdk.bosphor.xyz/docs/resume).

## Next steps

- [Payment flow](payment-flow.md): how the escrow, release, and refund work.
- [SDK documentation](https://sdk.bosphor.xyz): the full API for the EVM and Solana
  clients, including the lower-level steps.
- [Integration checklist](integration-checklist.md): what to check before you ship.
- [Contract interface](contract-interface.md): calling the adapter directly from
  Solidity or without the SDK.
- [Testnet reference](https://sdk.bosphor.xyz/docs/reference/testnet): every
  deployed address and endpoint id.
