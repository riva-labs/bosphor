---
title: How routing works
description: The commitment model, the out-of-band bytes, and why the cross-chain fee is flat.
---

Bosphor lets a wallet on one chain store a file on Walrus (a storage network on
Sui) and get a proof back, without that file ever crossing a bridge. This page
explains the model so the SDK's behaviour makes sense.

## The problem

Walrus lives on Sui. A user with only an EVM or Solana wallet cannot pay for or
address Walrus storage directly. Bridging the file itself would be slow, expensive,
and scale with file size. Bosphor bridges a **commitment**, not the bytes.

## The commitment

The Walrus blob id is a deterministic function of the file's bytes. The SDK
computes it **locally** (no Sui RPC, no WAL) and packs it, with the size, encoding,
storage duration, and a deadline, into a fixed 49-byte commitment. That commitment,
plus a per-sender nonce, hashes to a canonical `intentId`, the **same keccak digest
on EVM, Solana, and Sui**.

Only the commitment travels over LayerZero. The raw bytes are handed to the relayer
**out-of-band** over plain HTTP. This is why the LayerZero fee is **flat**: the
cross-chain message is a fixed 49 bytes whether the file is 1 KB or 1 GB.

## The round-trip

```
origin chain            LayerZero            Sui / Walrus
──────────────          ─────────            ────────────
submit(commitment)  ──────────────────▶  IntentReceived
   │                                          │
upload(bytes) ─▶ relayer ────────────────▶ store on Walrus
   │                                          │
   ◀────────────────────────────────────  execute_store
awaitProof: executed=true                  (proof: blobId, endEpoch)
```

1. **submit** puts the commitment on the origin adapter and emits `IntentSubmitted`.
2. LayerZero delivers the message to Sui, where it becomes an `IntentReceived`.
3. **upload** hands the raw bytes to the relayer out-of-band.
4. The relayer stores the blob on Walrus and records it on Sui. The Sui side
   verifies the stored blob's id equals the committed id, so a wrong or swapped
   file is rejected on-chain.
5. A proof (`blobId`, `endEpoch`) is sent back to the origin chain, where the
   adapter marks the intent `executed`.
6. **awaitProof** sees `executed=true` and returns the verified result.

## Why every result is verified

The SDK never trusts a value it did not check. `store()` only resolves after the
origin chain reports the intent executed and exposes the committed blob id and end
epoch. A relayer that returns the wrong blob id cannot pass the on-chain reference
check, so the SDK cannot hand you a fabricated result.

## Where the SDK fits

The SDK owns the origin-chain half: computing the blob id, building and submitting
the commitment, uploading the bytes, and polling for the proof. The relayer and the
DVN (the LayerZero verifier) own the middle. The [API reference](/reference/)
documents every method the SDK exposes for this.
