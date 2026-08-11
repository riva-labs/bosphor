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
| `@bosphor/sdk/solana` | Reserved for a later milestone. |

The chain SDKs are **optional peer dependencies**, so a codec-only or non-EVM
consumer never pulls them:

- `ethers` (EVM client)
- `@mysten/walrus` and `@mysten/sui` (client-side blob-id computation)

Install only what your path needs. For the full EVM `store()` flow:

```bash
npm install @bosphor/sdk ethers @mysten/walrus @mysten/sui
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

## For Solidity integrators

Contracts consuming Bosphor execution proofs can import `BosphorProof`
(`contracts/evm/src/BosphorProof.sol`) to decode the `IntentExecuted` proof
(`abi.encode(bytes32 blobId, uint256 endEpoch)`) and read execution state from the
adapter.
