---
title: Resume after a crash
description: Pick a cancelled or crashed flow back up without re-signing or double-spending.
---

A storage intent is a multi-step, money-spending operation. If the process is
cancelled or crashes mid-flow, the right move is to **resume**, not to blindly
retry: an already-submitted intent must not be submitted again.

## The steps are the checkpoints

Because every step is public and returns a plain value, the `intentId` from
`submit` is your durable checkpoint. Persist it as soon as you have it:

```ts
const encoded = await client.encode(fileBytes, { epochs: 5 });
const fee = await client.quote(encoded);
const { intentId } = await client.submit(encoded, fee);

await db.save(jobId, { intentId }); // <- durable checkpoint

await client.upload(intentId, fileBytes);
const proof = await client.awaitProof(intentId);
```

## Resume rules

Given a saved `intentId`, resume from wherever you stopped, **without re-submitting**:

- **Aborted while awaiting the proof** — the intent is on-chain and the bytes are
  uploaded. Just re-poll:

  ```ts
  const proof = await client.awaitProof(saved.intentId, { timeoutMs: 300_000 });
  ```

- **Aborted during or before the upload** — the intent is on-chain but the relayer
  may not have the bytes. Re-run the upload first, then poll:

  ```ts
  await client.upload(saved.intentId, fileBytes);
  const proof = await client.awaitProof(saved.intentId);
  ```

- **Aborted before submit** — nothing is on-chain yet. Start the flow again from
  `encode`.

## Why not auto-retry

Re-submitting a signed intent risks a second on-chain intent for the same bytes.
The SDK therefore does **not** auto-retry the signed submit. Reads (`quote`,
`awaitProof`) are safe to retry; the signed submit is yours to resume deliberately.

## Cancellation contract

`store` and `awaitProof` accept an `AbortSignal`. On abort the promise rejects with
the signal's reason, the same contract as `fetch`, and the on-chain intent is left
intact for you to resume with the rules above.
