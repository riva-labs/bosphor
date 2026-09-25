# @bosphor/sdk

[![npm version](https://img.shields.io/npm/v/@bosphor/sdk)](https://www.npmjs.com/package/@bosphor/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@bosphor/sdk)](https://www.npmjs.com/package/@bosphor/sdk)
[![license](https://img.shields.io/npm/l/@bosphor/sdk)](./LICENSE)
![node](https://img.shields.io/node/v/@bosphor/sdk)
![module](https://img.shields.io/badge/module-ESM-f7df1e)
![types](https://img.shields.io/badge/types-included-3178c6)

Store a file on [Walrus](https://walrus.xyz) from an EVM or Solana wallet, over
[LayerZero](https://layerzero.network), and get a verifiable proof back on the
origin chain. One package, one lean subpath per chain, and a one-call `store()`.

- **One call.** `await client.store(bytes, { epochs })` runs the whole cross-chain
  flow and returns `{ intentId, blobId, endEpoch }`, verified against on-chain state.
- **Flat cross-chain cost.** The blob id is committed on-chain and the bytes travel
  out-of-band, so the LayerZero fee is the same for a 1 KB file and a 1 GB file.
- **Same API on every chain.** The EVM and Solana clients are byte-for-byte identical
  where they overlap; the intent id is the same keccak digest across EVM, Sui, and Solana.
- **Lean by default.** Chain SDKs are optional peer dependencies loaded lazily, so a
  codec-only or single-chain consumer never pulls them.
- **No fabricated results.** Every failure throws a typed [`BosphorError`](#errors)
  with the on-chain or relayer reason; nothing is silently defaulted.

## Package layout

`@bosphor/sdk` ships chain-agnostic core code plus opt-in chain subpaths:

| Import | Contents |
|--------|----------|
| `@bosphor/sdk` | Core: the commitment codec (frozen wire format + intentId derivation) and shared types. No chain SDK. |
| `@bosphor/sdk/commitment` | The commitment codec on its own (kept for existing consumers). |
| `@bosphor/sdk/evm` | The EVM origin client and the one-call `store()`. |
| `@bosphor/sdk/solana` | The Solana origin client and the one-call `store()`. |

The chain SDKs are **optional peer dependencies**, so a codec-only or single-chain
consumer never pulls them:

- `ethers` (EVM client)
- `@solana/web3.js` (Solana client, default backend)
- `@mysten/walrus` and `@mysten/sui` (client-side blob-id computation)
- `@layerzerolabs/lz-solana-sdk-v2` (Solana: live LayerZero fee quotes and `resolveEndpointAccounts`)

The Solana path is Anchor-free: the SDK owns the program's binary interface (see
`src/solana/program.ts`), so no generated IDL is required.

Install only what your path needs. For the full EVM `store()` flow:

```bash
npm install @bosphor/sdk ethers @mysten/walrus @mysten/sui
```

For the full Solana `store()` flow:

```bash
npm install @bosphor/sdk @solana/web3.js @mysten/walrus @mysten/sui
```

## Testnet preset

`TESTNET` (exported from every entry point) holds every address, endpoint id,
LayerZero option, and URL of the hosted Bosphor testnet, so you never copy them by
hand:

| Field | Value |
|-------|-------|
| `TESTNET.relayerUrl` | `https://api.bosphor.xyz/testnet` |
| `TESTNET.evm.adapterAddress` | `0x3296686Fc61076d27488278c1da5468E1e0A7156` (Sepolia, EID 40161) |
| `TESTNET.solana.programId` | `7RCSzaG9NsK2BNMmLqQ22Zqrf6Te6Wvi5MNpknoit1AF` (devnet, EID 40168) |
| `TESTNET.sui.eid` | `40378` (Sui testnet, the destination) |

The one-call helpers below default to it. `walrusBlobUrl(blobId)` turns a returned
blob id into a Walrus aggregator URL you can open in a browser.

## EVM: store a file in one call

`store(data, { epochs })` runs the whole path and returns the verified result:

```
encode -> quote -> submit -> upload -> awaitProof
```

```ts
import { ethers } from "ethers";
import { createBosphorClientFromSigner } from "@bosphor/sdk/evm";

const signer = new ethers.Wallet(PRIVATE_KEY, new ethers.JsonRpcProvider(SEPOLIA_RPC_URL));
const client = await createBosphorClientFromSigner(signer); // TESTNET by default

const { intentId, blobId, endEpoch, txHash } = await client.store(fileBytes, { epochs: 5 });
```

`createBosphorClientFromSigner` binds the adapter with the bundled `ADAPTER_ABI`,
wires the `queryProof` reader the client needs to resolve `endEpoch`, and fills the
relayer URL, destination endpoint id, and LayerZero options from the preset. To
wire it by hand (a custom deployment, or a different `ethers` setup), use
`new ethers.Contract(address, ADAPTER_ABI, signer)` with `fromEthersContract` and
`createBosphorClient`. `store()` returns the origin `txHash` alongside the verified
result. Every step is verified against on-chain state before `store()` resolves.
Nothing is fabricated: a relayer rejection throws `RelayerUploadError` with the
relayer's reason, and an intent that never executes throws `ProofTimeoutError`.

### Paying for storage

`storePriced()` is the user-pays flow: it fetches a single all-in origin-native
quote from the relayer (WAL + Sui gas + return leg, buffered, plus the forward LZ
fee), surfaces the USD breakdown, pays the escrow plus the forward fee at submit,
and awaits the proof that releases the escrow to the relayer. If the proof never
lands, the deposit refunds to the payer after the deadline.

```ts
// Preview the quote, then pay in one call. Works the same on EVM and Solana.
const encoded = await client.encode(fileBytes, { epochs: 5 });
const quote = await client.priceQuote(encoded);
console.log(quote.totalNative, quote.breakdown.totalUsd);

const { intentId, blobId, endEpoch, quote: used } = await client.storePriced(
  fileBytes,
  { epochs: 5 },
);
```

See `examples/store-file-priced.evm.ts` and `examples/store-file-priced.solana.ts`.

### Quote without a wallet

Show a price before any wallet is connected. Each needs only a read-only
provider or connection:

```ts
import { JsonRpcProvider } from "ethers";
import { TESTNET, quoteEvmStore } from "@bosphor/sdk/evm";

const quote = await quoteEvmStore({
  provider: new JsonRpcProvider(TESTNET.evm.rpcUrl),
  sizeBytes: file.size, // or: data: bytes
  epochs: 5,
});

// Solana: quoteSolanaStore({ connection, sizeBytes }) from "@bosphor/sdk/solana"
```

`quote.forwardIsUpperBound` is `true` only when the LayerZero part is a fee cap
rather than the live fee (Solana without the optional peer
`@layerzerolabs/lz-solana-sdk-v2`); the actual charge is then lower.

### Progress

`store()` and `storePriced()` take an `onProgress` callback that fires after each
step: `encoded`, `quoted` (`amount`), `submitted` (`intentId`, `txHash`),
`uploaded`, and `proven` (`blobId`, `endEpoch`):

```ts
await client.storePriced(bytes, {
  onProgress: (e) => {
    if (e.step === "submitted") showTx(e.txHash);
    else setStep(e.step);
  },
});
```

### Refunds

If no proof lands before the intent deadline (1 hour by default), the escrow can
be refunded to the payer. Anyone may trigger it.

```ts
// EVM: refund credits the payer, withdraw pays it out (pull payment).
const escrow = await client.getEscrow(intentId); // status: 0 None, 1 Pending, 2 Released, 3 Refunded
await client.refund(intentId);
await client.withdraw(); // from the payer's wallet

// Solana: one instruction closes the vault back to the payer.
await solanaClient.refundEscrow(intentId);
```

### Lower-level escape hatches

The steps `store()` and `storePriced()` orchestrate are all public:

```ts
const encoded = await client.encode(fileBytes, { epochs: 5 });
const fee = await client.quote(encoded);
const { intentId, txHash } = await client.submit(encoded, fee);
await client.upload(intentId, fileBytes);
const { blobId, endEpoch } = await client.awaitProof(intentId, {
  timeoutMs: 300_000,
  pollMs: 3_000,
});
// Or, for the priced path: priceQuote() -> submitPaid() -> upload() -> awaitProof().
```

### Blob-id computation

The Walrus blob id is derived locally from the bytes (no SUI, no WAL, no Sui RPC),
so the id the SDK commits to matches what the relayer recomputes on ingest. The
computation is injectable via `computeBlob` in the client options; the default
lazily loads `@mysten/walrus`. Because the RedStuff encoding depends on the
network, set `network: "mainnet"` on the client for a mainnet adapter (the default
is `"testnet"`), or pass a custom `computeBlob`. Tests pass a stub and never load
the Walrus SDK.

See `examples/store-file.evm.ts` for a runnable end-to-end script.

### Identifying your app (`appId`)

Pass an optional `appId` (a short slug such as `"my-dapp"`) to either client.
The SDK sends it as the `X-Bosphor-App` header on quote and upload requests, and
the relayer records it with every intent, so usage from your app can be counted
separately from scripts and tests. It is attribution only, not authentication.

```ts
const client = createBosphorClient({
  adapter: fromEthersContract(contract),
  relayerUrl: "https://api.bosphor.xyz/testnet",
  dstEid: 40378,
  appId: "my-dapp", // letters, digits, "-", "_", "."; max 64 chars
});
```

A malformed `appId` throws at construction. Omitting it is fine: the intent is
recorded without an app.

## Solana: store a file in one call

The Solana path has the SAME one-line API. `store(data, { epochs })` runs the whole
flow and returns the verified result:

```
encode -> submit -> upload -> awaitProof
```

Solana has no separate `quote` step: the LayerZero messaging fee is passed as
`nativeFee` (lamports) on the `submit_intent` instruction.

```ts
import { Connection, Keypair } from "@solana/web3.js";
import { TESTNET, createBosphorSolanaClientFromKeypair } from "@bosphor/sdk/solana";

const connection = new Connection(TESTNET.solana.rpcUrl, "confirmed");
const client = await createBosphorSolanaClientFromKeypair({ connection, wallet: keypair });

const { intentId, blobId, endEpoch } = await client.store(fileBytes, { epochs: 5 });
```

For an exact LayerZero fee in `priceQuote()`, also install the optional peer
`@layerzerolabs/lz-solana-sdk-v2`: the helper then reads the live fee with a
read-only simulation (`quoteSolanaLzFee`). Without it, the quote uses the preset
fee cap and sets `forwardIsUpperBound: true`.

`submit_intent` makes a CPI into the LayerZero endpoint, which needs a fixed list
of "send" accounts. The helper uses `testnetEndpointAccounts(payer)`, a published
snapshot of that list for the testnet pathway. If LayerZero ever changes the
pathway's configuration, resolve the live list instead with
`resolveEndpointAccounts({ connection, payer })` (needs the optional peer
`@layerzerolabs/lz-solana-sdk-v2`) and pass it as `endpointAccounts`. The
lower-level `createDefaultSolanaChain` + `BosphorSolanaClient` pair stays available
for full control.

The canonical intent id is the SAME keccak digest as the EVM and Sui paths (shared
`bosphor_commitment_codec`). The backend derives it from the on-chain nonce with
the shared codec and cross-checks it against the `IntentSubmitted` event in the
confirmed transaction.

Verification reads the on-chain `IntentState` PDA (`[b"intent", intentId]`), which
`lz_receive` marks `executed` and stamps with the returned blob id and end epoch.
Nothing is fabricated: a relayer rejection throws `RelayerUploadError`, and an
intent that never executes throws `ProofTimeoutError`.

### Chain seam and testing

`BosphorSolanaClient` talks to the chain through a minimal structural interface,
`SolanaChain` (`submitIntent(fields)` and `readIntent(intentId)`), so unit tests
inject a fake and never load `@solana/web3.js`. The real backend
(`createDefaultSolanaChain`) loads the Solana stack via a lazy dynamic import, the
same seam used for `@mysten/walrus`, so a codec-only or EVM-only consumer never
pulls it.

### Proof reader (for on-chain / CPI consumers)

The on-chain proof of record is the `IntentState` PDA. `decodeIntentState(bytes)`
deserializes raw account bytes (e.g. from `connection.getAccountInfo`) into the
Anchor struct fields, and `readSolanaProof(...)` reduces raw bytes or a decoded
state to `{ executed, blobId, endEpoch }`. Both come from `@bosphor/sdk/solana`.
For CPI consumers, on-chain verification reads the same `IntentState` PDA.

See `examples/store-file.solana.ts` for a runnable end-to-end script.

## Errors

Every failure throws a typed error that extends `BosphorError`, so you can catch the
base class once and narrow on the concrete type. Nothing is fabricated on error.

```ts
import { BosphorError, ProofTimeoutError, RelayerUploadError } from "@bosphor/sdk";

try {
  await client.store(bytes, { epochs: 5 });
} catch (e) {
  if (e instanceof RelayerUploadError) {
    // e.status (HTTP), e.reason (the relayer's message), e.intentId
  } else if (e instanceof ProofTimeoutError) {
    // e.intentId, e.timeoutMs; the intent may still execute, so re-poll awaitProof
  } else if (e instanceof BosphorError) {
    // any other SDK error
  }
}
```

Every error carries two fields that are part of the stable API, not the message: a
machine-readable `code` string (the message may change; the code will not) and a
`retryable` boolean saying whether retrying the same call could succeed.

| Error | `code` | Thrown by | Fields | `retryable` |
|-------|--------|-----------|--------|-------------|
| `RelayerUploadError` | `RELAYER_UPLOAD_FAILED` | `upload`, `store` | `status`, `reason`, `intentId` | `true` for a 404 (watch-lag race) or 5xx; `false` for a terminal 4xx (already executed, expired, bad blob). |
| `ProofTimeoutError` | `PROOF_TIMEOUT` | `awaitProof`, `store` | `intentId`, `timeoutMs` | `true`. The intent may still execute; re-poll with `awaitProof(intentId)`. |
| `BosphorError` | `BOSPHOR_ERROR` | base class | `code`, `retryable` | `false` by default. Superclass of every SDK error. |

The errors are exported from the core `@bosphor/sdk` and from both chain subpaths.

## API surface

| Import | Exports |
|--------|---------|
| `@bosphor/sdk` | `encodeCommitment`, `decodeCommitment`, `deriveIntentId`, `COMMITMENT_BYTES`/`BLOB_ID_BYTES`/`SENDER_BYTES`; `BosphorError`/`ProofTimeoutError`/`RelayerUploadError`; `fetchQuote`; `TESTNET`, `networks`, `walrusBlobUrl`, `blobIdToBase64Url`; types `Commitment`, `BlobEncoding`, `ComputeBlob`, `StoreResult`, `EncodeOptions`, `AwaitProofOptions`, `EncodedIntent`, `FetchLike`, `Hex`, `PricedQuote`, `QuoteRequest`, `QuoteBreakdown`, `BosphorNetwork` |
| `@bosphor/sdk/commitment` | The commitment codec on its own. |
| `@bosphor/sdk/evm` | `createBosphorClientFromSigner`, `connectAdapter`, `quoteEvmStore`, `ADAPTER_ABI`, `EscrowStatus`, `BosphorEvmClient`, `createBosphorClient`, `fromEthersContract`, `decodeProofEndEpoch`, `defaultComputeBlob`, `createDefaultComputeBlob`; the preset, errors, and core codec re-exported; types `AdapterContract`, `BosphorEvmClientOptions`, `MessagingFee`, `EthersContractLike`, `CreateClientFromSignerOptions` |
| `@bosphor/sdk/solana` | `createBosphorSolanaClientFromKeypair`, `quoteSolanaStore`, `quoteSolanaLzFee`, `testnetEndpointAccounts`, `resolveEndpointAccounts`, `TESTNET_SEND_ACCOUNTS`, `BosphorSolanaClient`, `createBosphorSolanaClient`, `createDefaultSolanaChain`, `decodeIntentState`, `readSolanaProof`, `BOSPHOR_PROGRAM_ID`; the preset, errors, and core codec re-exported; types `SolanaChain`, `BosphorSolanaClientOptions`, `SubmitOptions`, `CreateSolanaClientFromKeypairOptions` |

## For Solidity integrators

Contracts consuming Bosphor execution proofs can import `BosphorProof`
(`contracts/evm/src/BosphorProof.sol`) to decode the `IntentExecuted` proof
(`abi.encode(bytes32 blobId, uint256 endEpoch)`) and read execution state from the
adapter.

## Cancellation

Every long-running flow accepts an `AbortSignal`. Pass `signal` to `store` or
`awaitProof` to cancel the wait (and the in-flight relayer upload); on abort the
promise rejects with the signal's reason, the same contract as `fetch`.

The on-chain intent is not rolled back. To resume after a cancellation: if it
aborted while waiting for the proof, re-poll with `awaitProof(intentId)`; if it
aborted during or before the blob upload, re-run `upload(intentId, data)` first
(the relayer cannot execute the intent until it has the bytes), then re-poll.

```ts
const ac = new AbortController();
const timeout = setTimeout(() => ac.abort(new Error("took too long")), 30_000);
try {
  const result = await client.store(fileBytes, { epochs: 5, signal: ac.signal });
} finally {
  clearTimeout(timeout);
}
```

## Compatibility

- **Runtime:** Node.js >= 22 (see `engines`). Works in modern browsers and bundlers
  (Vite, webpack, esbuild) that support ESM.
- **Module format:** ESM only (`"type": "module"`). There is no CommonJS build; use
  `import`, not `require`.
- **Types:** ship with the package (`.d.ts` for every entry point), no `@types`
  package needed.
- **Tree-shaking:** `"sideEffects": false`, so bundlers drop the subpaths you do not
  import. A codec-only consumer never pulls a chain SDK.

## Versioning & stability

The SDK follows [semantic versioning](https://semver.org). It is pre-1.0, so while
minor versions may still change the API, breaking changes are called out in
[`CHANGELOG.md`](./CHANGELOG.md). The commitment wire format and `intentId`
derivation are frozen and covered by cross-chain parity vectors, so those do not
change under you. Pin a caret range (`^0.x`) and read the changelog before bumping.

## Security

See the repository [`SECURITY.md`](../SECURITY.md) for how to report a
vulnerability. The SDK computes the blob id locally and every result is verified
against on-chain state before `store()` resolves; nothing is trusted blindly and
nothing is fabricated on failure.

## API reference

The full docs, guides for the EVM and Solana paths, and the generated API
reference live at **[docs.bosphor.xyz](https://docs.bosphor.xyz)**.

Full type signatures also ship with the package as `.d.ts`, so your editor shows
every parameter, return type, and doc comment inline.

## Building from source

The published package ships compiled ESM in `dist/` (`.js` + `.d.ts` + source maps);
`main`, `module`, `types`, and the `exports` conditions all resolve there.

```bash
npm run build      # tsc -> dist/ (.js, .d.ts, maps)
npm run typecheck  # tsc --noEmit
npm test           # node --test over src/**/*.test.ts (no network, no peers)
```

The runnable examples import the package by name, so build once first:

```bash
npm run build
node --import tsx examples/store-file.evm.ts
```

## Releasing

Publishing is gated by `prepublishOnly` (clean, build, test), and the package is
`publishConfig.access: public`.

- **Preferred:** the `Publish SDK` GitHub Actions workflow
  (`.github/workflows/publish-sdk.yml`). Bump the version, merge to `main`, then run
  the workflow (Actions -> Publish SDK -> Run workflow) or publish a GitHub Release.
  It typechecks, builds, tests, and publishes only if the version is new (idempotent).
  Requires a one-time `NPM_TOKEN` repository secret scoped to `@bosphor/sdk`.
- **Manual:** `npm publish` from `sdk/` with an authenticated npm session that has
  write access to the `@bosphor` scope.
