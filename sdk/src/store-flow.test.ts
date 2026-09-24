import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientRpcError } from "./store-flow.js";

test("isTransientRpcError: network resets, timeouts, 429 and 5xx are transient", () => {
  const reset = Object.assign(
    new Error(
      "Client network socket disconnected before secure TLS connection was established",
    ),
    { code: "ECONNRESET" },
  );
  assert.equal(isTransientRpcError(reset), true);
  assert.equal(
    isTransientRpcError(Object.assign(new Error("x"), { code: "ETIMEDOUT" })),
    true,
  );
  assert.equal(
    isTransientRpcError(Object.assign(new Error("x"), { code: "TIMEOUT" })),
    true,
    "ethers TIMEOUT",
  );
  assert.equal(
    isTransientRpcError(
      Object.assign(new Error("x"), { code: "NETWORK_ERROR" }),
    ),
    true,
  );
  assert.equal(isTransientRpcError(new Error("fetch failed")), true);
  assert.equal(isTransientRpcError(new Error("429 Too Many Requests")), true);
  assert.equal(
    isTransientRpcError(new Error("server responded with 503")),
    true,
  );
  assert.equal(
    isTransientRpcError({ code: "SERVER_ERROR", message: "bad response" }),
    true,
    "ethers SERVER_ERROR (5xx from the RPC)",
  );
});

test("isTransientRpcError: contract and logic errors are not transient", () => {
  assert.equal(isTransientRpcError(new Error("execution reverted")), false);
  assert.equal(
    isTransientRpcError(
      Object.assign(new Error("x"), { code: "CALL_EXCEPTION" }),
    ),
    false,
  );
  assert.equal(
    isTransientRpcError(new TypeError("adapter.executed is not a function")),
    false,
  );
  assert.equal(isTransientRpcError(undefined), false);
  const aborted = new Error("aborted");
  aborted.name = "AbortError";
  assert.equal(
    isTransientRpcError(aborted),
    false,
    "a caller abort must never be retried",
  );
});
