# @bosphor/sdk

The Bosphor SDK: cross-chain storage intents for Walrus. One package, one lean
subpath per chain, and a high-level one-call flow for storing data.

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
import { BosphorEvmClient, type AdapterContract } from "@bosphor/sdk/evm";

const signer = new ethers.Wallet(PRIVATE_KEY, provider);
const contract = new ethers.Contract(ADAPTER_ADDRESS, ADAPTER_ABI, signer);

const client = new BosphorEvmClient({
  adapter: contract as unknown as AdapterContract,
  relayerUrl: "https://relayer.bosphor.xyz",
  dstEid: 40378, // Sui testnet
});

const { intentId, blobId, endEpoch } = await client.store(fileBytes, { epochs: 5 });
```

Every step is verified against on-chain state before `store()` resolves. Nothing
is fabricated: a relayer rejection throws `RelayerUploadError` with the relayer's
reason, and an intent that never executes throws `ProofTimeoutError`.

### Lower-level escape hatches

The steps `store()` orchestrates are all public:

```ts
const encoded = await client.encode(fileBytes, { epochs: 5 });
const fee = await client.quote(encoded);
const { intentId } = await client.submit(encoded, fee);
await client.upload(intentId, fileBytes);
const { blobId, endEpoch } = await client.awaitProof(intentId, {
  timeoutMs: 300_000,
  pollMs: 3_000,
});
```

### Blob-id computation

The Walrus blob id is derived locally from the bytes (no SUI, no WAL, no Sui RPC),
so the id the SDK commits to matches what the relayer recomputes on ingest. The
computation is injectable via `computeBlob` in the client options; the default
lazily loads `@mysten/walrus`. Tests pass a stub and never load the Walrus SDK.

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

## For Solidity integrators

Contracts consuming Bosphor execution proofs can import `BosphorProof`
(`contracts/evm/src/BosphorProof.sol`) to decode the `IntentExecuted` proof
(`abi.encode(bytes32 blobId, uint256 endEpoch)`) and read execution state from the
adapter.
