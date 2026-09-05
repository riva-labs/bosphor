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

The SDK adds `storePriced()`: quote, pay, upload, and await-proof in one call, on
both EVM and Solana. It surfaces the full breakdown so you can show the user what
they are paying before they sign.

```ts
import { createBosphorClient } from "@bosphor/sdk/evm";

const client = createBosphorClient({ adapter, relayerUrl, dstEid });

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

The lower-level steps, `priceQuote`, `submitPaid`, `upload`, `awaitProof`, are all
individually callable. See the SDK examples `store-file-priced.evm.ts` and
`store-file-priced.solana.ts`.

## The quote endpoint

The relayer exposes the pricing as `POST /quote`. Bigint amounts are decimal
strings so no precision is lost.

```bash
curl -s https://api.bosphor.xyz/testnet/quote \
  -H 'content-type: application/json' \
  -d '{"sizeBytes":1048576,"originToken":"ETH","forwardLzFeeNative":"1211000000000000"}'
```

```json
{
  "originToken": "ETH",
  "escrowNative": "821243000000000",
  "forwardNative": "1211000000000000",
  "totalNative": "2032243000000000",
  "breakdown": { "escrowUsd": 2.05, "totalUsd": 5.18, "floorApplied": false, "...": "..." }
}
```

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

The owner `confirmExecution` fallback marks an intent executed for observability
but never moves escrowed funds: only a genuine proof can release the escrow.

Payment is native (ETH/SOL) today. A USDC path (Permit2 witness deposit + CCTP
settlement) is scaffolded behind mocks as a fast-follow.
