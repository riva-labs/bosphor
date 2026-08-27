import { test } from "node:test";
import assert from "node:assert/strict";
import { BosphorError, ProofTimeoutError, RelayerUploadError } from "./errors.js";

test("BosphorError carries a default code, is not retryable, and is an Error", () => {
  const e = new BosphorError("boom");
  assert.equal(e.code, "BOSPHOR_ERROR");
  assert.equal(e.retryable, false);
  assert.equal(e.name, "BosphorError");
  assert.ok(e instanceof Error);
});

test("BosphorError preserves the cause chain", () => {
  const cause = new Error("root");
  const e = new BosphorError("wrap", { cause });
  assert.equal(e.cause, cause);
});

test("ProofTimeoutError has a stable code and is retryable", () => {
  const e = new ProofTimeoutError("0xabc", 1000);
  assert.equal(e.code, "PROOF_TIMEOUT");
  assert.equal(e.retryable, true);
  assert.equal(e.intentId, "0xabc");
  assert.equal(e.timeoutMs, 1000);
  assert.ok(e instanceof BosphorError);
});

test("RelayerUploadError has a stable code and status-derived retryable", () => {
  const notFound = new RelayerUploadError("0xabc", 404, "no pending intent");
  assert.equal(notFound.code, "RELAYER_UPLOAD_FAILED");
  assert.equal(notFound.retryable, true, "404 is the watch-lag race, retry past it");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.reason, "no pending intent");

  assert.equal(
    new RelayerUploadError("0xabc", 409, "already executed").retryable,
    false,
    "a terminal 4xx is not retryable",
  );
  assert.equal(
    new RelayerUploadError("0xabc", 503, "unavailable").retryable,
    true,
    "a 5xx is transient",
  );
});

test("every SDK error is catchable as the base class", () => {
  const errors = [
    new ProofTimeoutError("0xabc", 1),
    new RelayerUploadError("0xabc", 500, "x"),
  ];
  for (const e of errors) assert.ok(e instanceof BosphorError);
});
