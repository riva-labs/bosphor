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

## EVM: store a file in one call

`store(data, { epochs })` runs the whole path and returns the verified result:

```
encode -> quote -> submit -> upload -> awaitProof
```

```ts
import { ethers } from "ethers";
import { createBosphorClient, fromEthersContract } from "@bosphor/sdk/evm";

const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(ADAPTER_ADDRESS, ADAPTER_ABI, signer);

const client = createBosphorClient({
  adapter: fromEthersContract(contract),
  relayerUrl: "https://api.bosphor.xyz/testnet",
  dstEid: 40378, // Sui testnet
});

const { intentId, blobId, endEpoch, txHash } = await client.store(fileBytes, { epochs: 5 });
```

`fromEthersContract(contract)` builds the whole adapter surface, including the
`queryProof` reader the client needs to resolve `endEpoch`, so there is no cast
and no boilerplate. `store()` returns the origin `txHash` alongside the verified
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
import { BosphorSolanaClient, createDefaultSolanaChain } from "@bosphor/sdk/solana";

const connection = new Connection(RPC_URL, "confirmed");

// Anchor-free: no IDL, no Program. `endpointAccounts` are the LayerZero send
// accounts assembled per the deployed LZ config.
const chain = await createDefaultSolanaChain({ connection, wallet: payer /*, endpointAccounts */ });

const client = new BosphorSolanaClient({
  chain,
  relayerUrl: "https://relayer.bosphor.xyz",
  dstEid: 40378, // Sui testnet
  nativeFee: quotedLamports,
});

const { intentId, blobId, endEpoch } = await client.store(fileBytes, { epochs: 5 });
```

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
| `@bosphor/sdk` | `encodeCommitment`, `decodeCommitment`, `deriveIntentId`, `COMMITMENT_BYTES`/`BLOB_ID_BYTES`/`SENDER_BYTES`; `BosphorError`/`ProofTimeoutError`/`RelayerUploadError`; types `Commitment`, `BlobEncoding`, `ComputeBlob`, `StoreResult`, `EncodeOptions`, `AwaitProofOptions`, `EncodedIntent`, `FetchLike`, `Hex` |
| `@bosphor/sdk/commitment` | The commitment codec on its own. |
| `@bosphor/sdk/evm` | `BosphorEvmClient`, `createBosphorClient`, `fromEthersContract`, `decodeProofEndEpoch`, `defaultComputeBlob`, `createDefaultComputeBlob`; the errors + core codec re-exported; types `AdapterContract`, `BosphorEvmClientOptions`, `MessagingFee`, `EthersContractLike` |
| `@bosphor/sdk/solana` | `BosphorSolanaClient`, `createBosphorSolanaClient`, `createDefaultSolanaChain`, `decodeIntentState`, `readSolanaProof`, `BOSPHOR_PROGRAM_ID`; the errors + core codec re-exported; types `SolanaChain`, `BosphorSolanaClientOptions`, `SubmitOptions` |

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
reference live at **[sdk.bosphor.xyz](https://sdk.bosphor.xyz)**.

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
