---
title: Handle errors
description: Catch the base error once and narrow on the concrete type; nothing is fabricated on failure.
---

Every failure throws a typed error that extends `BosphorError`, so you can catch
the base class once and narrow on the concrete type. Nothing is defaulted or
fabricated on error, the throw carries the on-chain or relayer reason.

```ts
import { BosphorError, ProofTimeoutError, RelayerUploadError } from '@bosphor/sdk';

try {
  await client.store(bytes, { epochs: 5 });
} catch (e) {
  if (e instanceof RelayerUploadError) {
    // e.status (HTTP), e.reason (the relayer's message), e.intentId
  } else if (e instanceof ProofTimeoutError) {
    // e.intentId, e.timeoutMs; the intent may still execute, so re-poll awaitProof
  } else if (e instanceof BosphorError) {
    // any other SDK error
  } else {
    throw e; // not from the SDK
  }
}
```

The errors are exported from the core `@bosphor/sdk` and from both chain subpaths,
so any import path works.

## The errors

| Error | Thrown by | Fields | Meaning |
|-------|-----------|--------|---------|
| `RelayerUploadError` | `upload`, `store` | `status`, `reason`, `intentId` | The relayer rejected the out-of-band blob upload (e.g. no pending intent yet, or a blob-id mismatch). |
| `ProofTimeoutError` | `awaitProof`, `store` | `intentId`, `timeoutMs` | The intent did not execute within the timeout. It may still execute; re-poll with `awaitProof(intentId)`. |
| `BosphorError` | base class | — | Superclass of every SDK error. Catch this to handle any SDK failure. |

## No pending intent yet

`RelayerUploadError` with a 404 right after `submit` is the common race: the relayer
only accepts bytes once its watcher has seen your on-chain intent, a short lag after
you submit. If you drive the steps yourself, retry the upload past that window
rather than failing the flow; `store()` already handles this internally.

## A timeout is not a loss

`ProofTimeoutError` means the proof had not landed **yet**, not that the intent
failed. The intent is on-chain and the bytes are with the relayer, so re-poll:

```ts
const { blobId, endEpoch } = await client.awaitProof(e.intentId, { timeoutMs: 300_000 });
```
