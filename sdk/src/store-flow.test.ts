import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientRpcError, uploadBlob, type FetchLike } from "./store-flow.js";
import { RelayerUploadError } from "./errors.js";

const INTENT = "0x8d5172b628ac339fdd78c0cd899275cb4c6ae5698bb905f74f51890afaf08b25" as const;
const FAST = { baseDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 5_000 };

/** A fetch that answers with the scripted statuses in order, then the last one forever. */
function scripted(
  steps: Array<{ status: number; body?: string; retryAfter?: string } | Error>,
): { fetch: FetchLike; calls: () => number } {
  let n = 0;
  const fetchFn: FetchLike = async () => {
    const step = steps[Math.min(n, steps.length - 1)]!;
    n++;
    if (step instanceof Error) throw step;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      text: async () => step.body ?? "",
      headers: {
        get: (name: string) => (name === "retry-after" ? (step.retryAfter ?? null) : null),
      },
    };
  };
  return { fetch: fetchFn, calls: () => n };
}

test("uploadBlob retries the watch-lag 404 until the relayer sees the intent", async () => {
  const { fetch, calls } = scripted([
    { status: 404, body: "no pending intent for this id" },
    { status: 404, body: "no pending intent for this id" },
    { status: 200, body: "{}" },
  ]);
  await uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), { retry: FAST });
  assert.equal(calls(), 3);
});

test("uploadBlob retries 429 and 5xx, and transient network failures", async () => {
  const { fetch, calls } = scripted([
    { status: 429, retryAfter: "0" },
    { status: 503, body: "backpressure" },
    new TypeError("fetch failed"),
    new TypeError("Failed to fetch"),
    { status: 200 },
  ]);
  await uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), { retry: FAST });
  assert.equal(calls(), 5);
});

test("uploadBlob treats a 409 on a retry as success: an earlier attempt was ingested", async () => {
  // The first attempt reached the relayer but its answer was lost (a 503 from a
  // proxy, a dropped connection); by the retry the intent has moved on.
  const { fetch, calls } = scripted([
    { status: 503, body: "upstream timeout" },
    { status: 409, body: "intent already executed" },
  ]);
  await uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), { retry: FAST });
  assert.equal(calls(), 2);
});

test("uploadBlob still fails on a 409 to the first attempt", async () => {
  const { fetch } = scripted([{ status: 409, body: "intent already executed" }]);
  await assert.rejects(
    uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), { retry: FAST }),
    (e: unknown) => e instanceof RelayerUploadError && e.status === 409,
  );
});

test("uploadBlob does not retry a terminal rejection", async () => {
  const { fetch, calls } = scripted([{ status: 422, body: "blob id mismatch" }]);
  await assert.rejects(
    uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), { retry: FAST }),
    (e: unknown) => e instanceof RelayerUploadError && e.status === 422,
  );
  assert.equal(calls(), 1);
});

test("uploadBlob fails loudly with the last error once the attempts run out", async () => {
  const { fetch, calls } = scripted([{ status: 404, body: "no pending intent for this id" }]);
  await assert.rejects(
    uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), {
      retry: { ...FAST, maxAttempts: 4 },
    }),
    (e: unknown) =>
      e instanceof RelayerUploadError && e.status === 404 && /no pending intent/.test(e.reason),
  );
  assert.equal(calls(), 4);
});

test("uploadBlob exposes Retry-After on the error and stops when it exceeds the budget", async () => {
  const { fetch, calls } = scripted([{ status: 429, retryAfter: "120" }]);
  const err = await uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), {
    retry: { ...FAST, maxElapsedMs: 1_000 },
  }).catch((e: unknown) => e);
  assert.ok(err instanceof RelayerUploadError);
  assert.equal(err.retryAfterMs, 120_000);
  assert.equal(calls(), 1);
});

test("uploadBlob with retry: false makes exactly one attempt", async () => {
  const { fetch, calls } = scripted([{ status: 404 }]);
  await assert.rejects(
    uploadBlob(fetch, "https://r.test", INTENT, new Uint8Array([1]), { retry: false }),
    RelayerUploadError,
  );
  assert.equal(calls(), 1);
});

test("uploadBlob stops retrying when the signal aborts", async () => {
  const ac = new AbortController();
  let n = 0;
  const fetchFn: FetchLike = async () => {
    n++;
    if (n === 2) ac.abort(new Error("stop"));
    return { ok: false, status: 404, text: async () => "no pending intent" };
  };
  await assert.rejects(
    uploadBlob(fetchFn, "https://r.test", INTENT, new Uint8Array([1]), {
      signal: ac.signal,
      retry: FAST,
    }),
    /stop/,
  );
  assert.equal(n, 2);
});

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
