---
title: dApp Integration Tutorial
---

# dApp Integration Tutorial

Practical examples for integrating Bosphor into a frontend application. Bosphor stores your bytes on Walrus and returns a verified proof to your origin chain. In Milestone 3 the cross-chain fee is flat regardless of file size: only a compact commitment (blob id, size, encoding, storage duration, deadline) crosses the bridge, and the bytes are uploaded to the relayer out-of-band.

The relayer base URL is `https://api.bosphor.xyz/testnet` on testnet and `https://api.bosphor.xyz` on mainnet. The examples below use the testnet path.

import AgentPrompt from '@site/src/components/AgentPrompt';

<AgentPrompt prompt="Build a TypeScript module that stores bytes with Bosphor using @bosphor/sdk. I need a single store() call that (1) derives the Walrus blob id locally, (2) submits the commitment via the BosphorAdapter, (3) uploads the raw bytes out-of-band to the relayer, and (4) resolves with the verified { intentId, blobId, endEpoch }. Wire it to an ethers.js v6 signer and the deployed BosphorAdapter. The destination EID for Sui testnet is 40378 and the testnet relayer base URL is https://api.bosphor.xyz/testnet." />

## Recommended: @bosphor/sdk

The SDK is the recommended path. One `store()` call runs the whole flow: derive the blob id, quote, submit, upload the bytes out-of-band, and wait for the verified proof. Full guides and API reference live at [sdk.bosphor.xyz](https://sdk.bosphor.xyz).

```bash
npm install @bosphor/sdk ethers
```

```typescript
import { ethers } from "ethers";
import { createBosphorClient } from "@bosphor/sdk/evm";

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const ADAPTER_ADDRESS = "0x..."; // Your deployed BosphorAdapter address
const RELAYER_URL = "https://api.bosphor.xyz/testnet"; // mainnet: https://api.bosphor.xyz

// Minimal ABI the client needs: quote, submitIntent, and the IntentSubmitted event.
const adapter = new ethers.Contract(
  ADAPTER_ADDRESS,
  [
    "function quote(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
    "function submitIntent(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) payable returns (bytes32)",
    "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)",
  ],
  signer
);

const client = createBosphorClient({
  adapter,
  relayerUrl: RELAYER_URL,
  dstEid: 40378, // Sui testnet
  // LZ execution options: type 3 (lzReceive), 200k gas limit.
  options: "0x00030100110100000000000000000000000000030d40",
});

// One call: derive blobId, submit the commitment, upload bytes out-of-band, wait for the proof.
const data = new TextEncoder().encode("data to store on Walrus");
const { intentId, blobId, endEpoch } = await client.store(data, { epochs: 5 });

console.log("Stored:", intentId, blobId, "expires at epoch", endEpoch.toString());
```

### Escape hatches

`store()` is the happy path. The client also exposes each step so you can drive them yourself: `encode(data)`, `quote(encoded)`, `submit(encoded, fee)`, `upload(intentId, data)`, and `awaitProof(intentId)`. This is useful when you want to show progress in the UI or retry a single step. If a `store()` call is interrupted after submit, re-run `client.upload(intentId, data)` (the relayer needs the bytes) and then `client.awaitProof(intentId)`.

## Raw path (ethers.js v6)

If you cannot use the SDK, here is the same flow against the contract directly. There are four steps: derive the commitment fields, quote, submit, and upload the bytes out-of-band.

### Setup

```typescript
import { ethers } from "ethers";
// The SDK's blob-id derivation is reusable on its own.
import { defaultComputeBlob } from "@bosphor/sdk/evm";

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const ADAPTER_ADDRESS = "0x..."; // Your deployed BosphorAdapter address
const RELAYER_URL = "https://api.bosphor.xyz/testnet"; // mainnet: https://api.bosphor.xyz
const DST_EID = 40378; // Sui testnet
const OPTIONS = "0x00030100110100000000000000000000000000030d40"; // type 3, 200k gas

const adapter = new ethers.Contract(
  ADAPTER_ADDRESS,
  [
    "function quote(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
    "function submitIntent(uint32,bytes32,uint32,uint8,uint32,uint64,bytes) payable returns (bytes32)",
    "function executed(bytes32) view returns (bool)",
    "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes32 blobId, uint32 size, uint8 encodingType, uint32 storageEpochs, uint64 nonce, uint64 deadline)",
    "event IntentExecuted(bytes32 indexed intentId, bytes proof)",
  ],
  signer
);
```

### Derive the commitment and estimate fees

Compute the Walrus blob id, size, and encoding from your bytes, then quote. Always call `quote` before submitting to get the exact LayerZero fee.

```typescript
const data = new TextEncoder().encode("data to store on Walrus");

// Derive the commitment fields client-side.
const { blobId, size, encodingType } = await defaultComputeBlob(data);
const storageEpochs = 5;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour from now

const fee = await adapter.quote(
  DST_EID, blobId, size, encodingType, storageEpochs, deadline, OPTIONS
);
console.log("LZ fee:", ethers.formatEther(fee.nativeFee), "ETH");
```

### Submit the intent

```typescript
const tx = await adapter.submitIntent(
  DST_EID, blobId, size, encodingType, storageEpochs, deadline, OPTIONS,
  { value: fee.nativeFee }
);
const receipt = await tx.wait();

// Extract intentId from the IntentSubmitted event.
const event = receipt.logs
  .map((log) => {
    try { return adapter.interface.parseLog(log); } catch { return null; }
  })
  .find((e) => e?.name === "IntentSubmitted");

if (!event) throw new Error("IntentSubmitted event not found in receipt");
const intentId = event.args.intentId;
console.log("Intent submitted:", intentId);
```

### Upload the bytes out-of-band

The bytes never cross the bridge. POST them to the relayer, which recomputes the blob id and binds it to the on-chain commitment. See [Blob ingest](public-api.md#blob-ingest-out-of-band) for the full status-code contract.

```typescript
async function uploadBlob(intentId: string, data: Uint8Array) {
  // A 404 right after submit is usually a timing race (the relayer has not seen
  // the IntentSubmitted event yet). Retry with backoff.
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await fetch(`${RELAYER_URL}/blob/${intentId}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: data,
    });
    if (res.ok) return (await res.json()) as { intentId: string; blobId: string; size: number };
    if (res.status === 404 || res.status === 503) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    throw new Error(`blob upload rejected: ${res.status} ${await res.text()}`);
  }
  throw new Error("blob upload timed out waiting for the relayer to see the intent");
}

await uploadBlob(intentId, data);
```

### Wait for the execution proof

Confirmation arrives as the `IntentExecuted` event, or you can poll `executed(intentId)`. The proof is `abi.encode(blobId, endEpoch)`.

```typescript
function waitForProof(intentId: string, timeoutMs = 5 * 60_000) {
  return new Promise<{ blobId: string; endEpoch: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      adapter.off(filter, onExecuted);
      reject(new Error("Timed out waiting for IntentExecuted event"));
    }, timeoutMs);

    const filter = adapter.filters.IntentExecuted(intentId);
    const onExecuted = (_intentId: string, proof: string) => {
      clearTimeout(timeout);
      const [blobId, endEpoch] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bytes32", "uint256"],
        proof
      );
      resolve({ blobId, endEpoch: endEpoch.toString() });
    };
    adapter.once(filter, onExecuted);
  });
}

const { blobId: storedBlobId, endEpoch } = await waitForProof(intentId);
console.log("Confirmed:", storedBlobId, "expires at epoch", endEpoch);
```

## Displaying intent status to users

A typical UI flow for showing intent status:

1. **Committing**: derive the blob id from the user's bytes. No chain interaction yet.
2. **Submitting**: `submitIntent` is sent. Show a spinner; on confirmation show the intent id and a link to [LayerZero Scan](https://testnet.layerzeroscan.com).
3. **Uploading**: POST the bytes to the relayer. Surface a `422` as "data does not match the commitment" and a `413` as "file too large".
4. **Delivering**: LayerZero verifies and delivers the commitment to Sui.
5. **Storing**: the relayer uploads to Walrus and calls `execute_store` on Sui.
6. **Confirmed**: `IntentExecuted` received (or `executed(intentId)` is true). Show the Walrus blob id and expiry epoch.

The full round-trip from submission to confirmation typically takes 2 to 10 minutes on testnet, depending on LayerZero DVN verification time and relayer processing speed.

## Related

- [Contract Interface](contract-interface.md) for complete function signatures and Sui examples
- [Commitment Format](commitment-format.md) for the wire layout and intent id derivation
- [Blob ingest](public-api.md#blob-ingest-out-of-band) for the out-of-band upload contract
- [Integration Checklist](integration-checklist.md) for the full integration workflow
- [Troubleshooting](troubleshooting.md) for common issues
