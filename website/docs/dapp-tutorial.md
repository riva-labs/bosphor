---
title: dApp Integration Tutorial
---

# dApp Integration Tutorial

Practical examples for integrating Bosphor into a frontend application. These examples show how to submit storage intents, estimate fees, and listen for execution confirmations.

import AgentPrompt from '@site/src/components/AgentPrompt';

<AgentPrompt prompt="Build a TypeScript module that integrates with the Bosphor protocol. I need functions to: (1) estimate LayerZero fees via the `quote` function, (2) submit a storage intent via `submitIntent` with the quoted fee as msg.value, and (3) listen for the `IntentExecuted` event to confirm storage and decode the proof (blobId, endEpoch). Use ethers.js v6 or viem. The BosphorAdapter ABI and contract address are in the Bosphor repo under `contracts/evm/`. The destination EID for Sui testnet is 40378." />

## ethers.js v6

### Setup

```typescript
import { ethers } from "ethers";

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();

const ADAPTER_ADDRESS = "0x..."; // Your deployed BosphorAdapter address
const DST_EID = 40378; // Sui testnet

const adapter = new ethers.Contract(
  ADAPTER_ADDRESS,
  [
    "function quote(uint32,bytes,uint256,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
    "function submitIntent(uint32,bytes,uint256,bytes) payable returns (bytes32)",
    "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)",
    "event IntentExecuted(bytes32 indexed intentId, bytes proof)",
  ],
  signer
);
```

### Estimate fees

Always call `quote` before submitting to get the exact LayerZero fee:

```typescript
const payload = ethers.toUtf8Bytes("data to store on Walrus");
const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
// LZ execution options: type 3 (lzReceive), 200k gas limit. See Contract Interface > LZ Options.
const options = "0x00030100110100000000000000000000000000030d40";

const fee = await adapter.quote(DST_EID, payload, deadline, options);
console.log("LZ fee:", ethers.formatEther(fee.nativeFee), "ETH");
```

### Submit an intent

```typescript
const tx = await adapter.submitIntent(DST_EID, payload, deadline, options, {
  value: fee.nativeFee,
});
const receipt = await tx.wait();

// Extract intentId from the event
const event = receipt.logs
  .map((log) => {
    try { return adapter.interface.parseLog(log); } catch { return null; }
  })
  .find((e) => e?.name === "IntentSubmitted");

if (!event) throw new Error("IntentSubmitted event not found in receipt");
const intentId = event.args.intentId;
console.log("Intent submitted:", intentId);
```

### Listen for execution confirmation

```typescript
adapter.on("IntentExecuted", (intentId, proof) => {
  const [blobId, endEpoch] = ethers.AbiCoder.defaultAbiCoder().decode(
    ["bytes32", "uint256"],
    proof
  );
  console.log("Intent executed:", intentId);
  console.log("Walrus blob ID:", blobId);
  console.log("Storage expires at epoch:", endEpoch.toString());
});
```

### Full example: submit and wait

```typescript
async function submitAndWait(data: string, deadlineSeconds: number = 3600) {
  const payload = ethers.toUtf8Bytes(data);
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
  const options = "0x00030100110100000000000000000000000000030d40";

  // 1. Estimate fee
  const fee = await adapter.quote(DST_EID, payload, deadline, options);

  // 2. Submit intent
  const tx = await adapter.submitIntent(DST_EID, payload, deadline, options, {
    value: fee.nativeFee,
  });
  const receipt = await tx.wait();

  const event = receipt.logs
    .map((log) => {
      try { return adapter.interface.parseLog(log); } catch { return null; }
    })
    .find((e) => e?.name === "IntentSubmitted");

  if (!event) throw new Error("IntentSubmitted event not found in receipt");
  const intentId = event.args.intentId;

  // 3. Wait for execution confirmation (with timeout)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      adapter.removeAllListeners("IntentExecuted");
      reject(new Error("Timed out waiting for IntentExecuted event"));
    }, deadlineSeconds * 1000);

    const filter = adapter.filters.IntentExecuted(intentId);
    adapter.once(filter, (intentId, proof) => {
      clearTimeout(timeout);
      const [blobId, endEpoch] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["bytes32", "uint256"],
        proof
      );
      resolve({ intentId, blobId, endEpoch: endEpoch.toString() });
    });
  });
}
```

## viem

### Setup

```typescript
import { createPublicClient, createWalletClient, http, custom, parseAbi, toHex } from "viem";
import { sepolia } from "viem/chains";

const ADAPTER_ADDRESS = "0x..." as const; // Your deployed BosphorAdapter address
const DST_EID = 40378; // Sui testnet

const abi = parseAbi([
  "function quote(uint32,bytes,uint256,bytes) view returns (tuple(uint256 nativeFee, uint256 lzTokenFee))",
  "function submitIntent(uint32,bytes,uint256,bytes) payable returns (bytes32)",
  "event IntentSubmitted(bytes32 indexed intentId, address indexed sender, uint64 targetChainId, bytes payload, uint256 nonce, uint256 deadline)",
  "event IntentExecuted(bytes32 indexed intentId, bytes proof)",
]);

const publicClient = createPublicClient({
  chain: sepolia,
  transport: http(),
});

const walletClient = createWalletClient({
  chain: sepolia,
  transport: custom(window.ethereum),
});
```

### Estimate fees

```typescript
const payload = new TextEncoder().encode("data to store on Walrus");
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const options = "0x00030100110100000000000000000000000000030d40" as `0x${string}`;

const fee = await publicClient.readContract({
  address: ADAPTER_ADDRESS,
  abi,
  functionName: "quote",
  args: [DST_EID, toHex(payload), deadline, options],
});

console.log("LZ fee:", fee.nativeFee, "wei");
```

### Submit an intent

```typescript
const [account] = await walletClient.getAddresses();

const hash = await walletClient.writeContract({
  address: ADAPTER_ADDRESS,
  abi,
  functionName: "submitIntent",
  args: [DST_EID, toHex(payload), deadline, options],
  value: fee.nativeFee,
  account,
});

const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log("Intent submitted in block:", receipt.blockNumber);
```

### Watch for execution confirmation

```typescript
const unwatch = publicClient.watchContractEvent({
  address: ADAPTER_ADDRESS,
  abi,
  eventName: "IntentExecuted",
  onLogs: (logs) => {
    for (const log of logs) {
      console.log("Intent executed:", log.args.intentId);
      console.log("Proof:", log.args.proof);
    }
  },
});

// Call unwatch() to stop listening
```

## Displaying intent status to users

A typical UI flow for showing intent status:

1. **Pending**: User clicks "Store", transaction is submitted. Show a spinner.
2. **Submitted**: Transaction is confirmed on EVM. Show the intent ID and a link to [LayerZero Scan](https://testnet.layerzeroscan.com).
3. **Delivering**: LayerZero is verifying and delivering the message. Poll LZ Scan or wait for the event.
4. **Storing**: The relayer is uploading to Walrus and executing storage on Sui.
5. **Confirmed**: `IntentExecuted` event received. Show the Walrus blob ID and expiry epoch.

The full round-trip from submission to confirmation typically takes 2-10 minutes on testnet, depending on LayerZero DVN verification time and relayer processing speed.

## Related

- [Contract Interface](contract-interface.md) for complete function signatures and Sui examples
- [Integration Checklist](integration-checklist.md) for the full integration workflow
- [Troubleshooting](troubleshooting.md) for common issues
