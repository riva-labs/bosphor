---
sidebar_position: 7
title: Payment flow
---

# Origin-chain payment flow

From Milestone 4, storing on Bosphor is a paid operation. Instead of the relayer
fronting the Walrus cost for free, the user escrows payment on the origin chain
and that escrow is released to the relayer only when the trustless LayerZero
proof lands. If the store never completes, the escrow refunds to the payer after
a deadline. You always pay one all-in amount in the origin chain's native token
(ETH on EVM, SOL on Solana), quoted off chain.

:::info Availability
The payment flow is live on the hosted testnet for both origins, and verified end
to end on each:

- **Ethereum Sepolia**: the escrow adapter `0x3296686Fc61076d27488278c1da5468E1e0A7156`,
  including the proof-gated release and the deadline refund.
- **Solana devnet**: the Bosphor program `7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF`,
  where the escrow is held in a per-intent vault account and released on the proof.

All testnet addresses are on the [testnet reference](https://sdk.bosphor.xyz/docs/reference/testnet)
and in the SDK `TESTNET` preset.
:::

## How it works

```
submit (pay escrow + LZ fee)  ->  LZ  ->  Sui lz_receive  ->  relayer stores on Walrus
      |                                                              |
   escrow held on origin                                     lz_send_proof
      |                                                              |
      +<----------------- proof releases escrow to relayer <---------+

no proof by deadline  ->  anyone calls refund(intentId)  ->  payer credited
```

1. **Quote (off chain).** The relayer prices the full cost stack, the Walrus
   storage, the Sui gas, and the LayerZero return leg, into a single origin-native
   amount with buffers and a service margin. Contracts hold no oracle.
2. **Submit + pay.** You send `msg.value = forward LZ fee + escrow`. The adapter
   forwards only the LayerZero fee to the endpoint and escrows the rest, keyed by
   the intent id.
3. **Release on proof.** When the genuine Sui-originated proof arrives at
   `_lzReceive` and the returned blob id matches the commitment, the escrow is
   released to the relayer (pull-payment: it later calls `withdraw`).
4. **Refund on timeout.** If no proof lands by the deadline, anyone can call
   `refund(intentId)` and the recorded payer is credited. The relayer only ever
   earns on a completed store.

The forward LayerZero fee and origin gas are paid by you directly (spent by the
send and the transaction itself); LayerZero refunds any surplus. Only the escrow
bucket, the relayer-fronted cost, is custodied.

## Pay in one call (SDK)

The SDK adds `storePriced()`: quote, pay, upload, and await-proof in one call. It
surfaces the full breakdown so you can show the user what they are paying before
they sign. It has the same shape on EVM and Solana.

```ts
import { createBosphorClientFromSigner } from "@bosphor/sdk/evm";
// Solana: createBosphorSolanaClientFromKeypair({ connection, wallet }) from "@bosphor/sdk/solana"

const client = await createBosphorClientFromSigner(signer); // hosted testnet preset

// Preview the quote (optional).
const encoded = await client.encode(fileBytes, { epochs: 5 });
const quote = await client.priceQuote(encoded);
console.log(quote.breakdown.totalUsd, quote.totalNative); // USD + wei

// Pay and store in one call. The result carries the quote that was used.
const { intentId, blobId, endEpoch, quote: used } = await client.storePriced(
  fileBytes,
  { epochs: 5 },
);
```

`storePriced()` also takes an `onProgress` callback, called after each step
(`encoded`, `quoted`, `submitted` with the tx hash, `uploaded`, `proven`).

The lower-level steps, `priceQuote`, `submitPaid`, `upload`, `awaitProof`, are all
individually callable. On Solana, `nativeFee` (the LayerZero fee cap passed with
`submit_intent`) is set from the preset, and the escrow is deposited into the
intent's vault account. See the SDK examples `store-file-priced.evm.ts` and
`store-file-priced.solana.ts`.

### Quote without a wallet

To show a price before a wallet is connected, use the read-only helpers. They
return the same quote as `priceQuote()`:

```ts
import { JsonRpcProvider } from "ethers";
import { TESTNET, quoteEvmStore } from "@bosphor/sdk/evm";

const quote = await quoteEvmStore({ provider: new JsonRpcProvider(TESTNET.evm.rpcUrl), sizeBytes: 1024 });
// Solana: quoteSolanaStore({ connection, sizeBytes: 1024 }) from "@bosphor/sdk/solana"
```

On Solana the live LayerZero fee is read by simulating the LayerZero endpoint,
which needs the optional package `@layerzerolabs/lz-solana-sdk-v2`. Without it the
quote uses a 0.01 SOL fee cap and sets `forwardIsUpperBound: true`; the endpoint
charges only the live fee, so you pay less than `totalNative`.

### Refund an escrow

If no proof lands before the deadline (one hour after submit by default), anyone
can refund the escrow to the payer:

```ts
// EVM (pull payment): refund credits the payer, withdraw pays it out.
await client.refund(intentId);
await client.withdraw(); // from the payer's wallet

// Solana: closes the escrow vault back to the payer in one step.
await solanaClient.refundEscrow(intentId);
```

`client.getEscrow(intentId)` reads the escrow's amount, deadline, and status.

## The quote endpoint

The relayer exposes the pricing as `POST /quote`. Bigint amounts are decimal
strings so no precision is lost.

```bash
curl -s -X POST https://api.bosphor.xyz/testnet/quote \
  -H 'content-type: application/json' \
  -d '{"sizeBytes":1024,"epochs":5,"originToken":"ETH","forwardLzFeeNative":"299467979879960"}'
```

```json
{
  "originToken": "ETH",
  "escrowNative": "977017000000000",
  "forwardNative": "299467979879960",
  "totalNative": "1276484979879960",
  "breakdown": { "escrowUsd": 2.62, "totalUsd": 3.42, "floorApplied": false, "...": "..." }
}
```

These are real testnet numbers for a 1 KB file: about 0.001 ETH of escrow plus
about 0.0003 ETH of LayerZero fee. Most of the escrow covers the LayerZero return
leg, so the price grows only slowly with file size. Send `"originToken":"SOL"` for
a Solana quote in lamports.

- `escrowNative`, the relayer-fronted bucket you escrow.
- `forwardNative`, the forward LZ fee (and origin gas) you pay directly.
- `totalNative = escrowNative + forwardNative`, your `msg.value` at submit.

Prices come from a multi-source oracle (Pyth Hermes primary, CoinGecko fallback)
with staleness and sanity bounds; a spend or refund decision never rides on a
single or fabricated feed.

## Never lose money, by construction

Before spending any WAL, the relayer runs a break-even guard: it recomputes the
actual cost at live prices and only proceeds if the escrow covers cost plus a
minimum margin. Otherwise it skips, spends nothing, and the intent refunds on its
deadline. Every completed store is profitable by construction, and every skipped
one costs nothing. A per-intent profit-and-loss ledger and a negative-margin
alert make the invariant observable.

## Escrow contract surface

The escrow adapter adds these to the [contract interface](./contract-interface.md):

- `submitIntent{value: fee + escrow}(...)`, escrows the surplus above the LZ fee.
- `getEscrow(intentId) -> (payer, token, amount, deadline, status)`, the record.
- `refund(intentId)`, permissionless after the deadline; pays the payer.
- `withdraw()` / `withdrawToken(token)`, pull-payment for released/refunded funds.

The full ABI ships in the SDK as `ADAPTER_ABI` (from `@bosphor/sdk/evm`), with
`EscrowStatus` for decoding `getEscrow(...).status` (`0` none, `1` pending, `2`
released, `3` refunded).

On Solana, the escrow lives in a vault account derived from the intent id
(`[b"escrow", intentId]`), and the `refund_escrow` instruction returns it to the
payer after the deadline.

The owner `confirmExecution` fallback marks an intent executed for observability
but never moves escrowed funds: only a genuine proof can release the escrow.

Payment is native (ETH/SOL) today. A USDC path (Permit2 witness deposit + CCTP
settlement) is scaffolded behind mocks as a fast-follow.
