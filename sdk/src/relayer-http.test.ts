import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRetryAfter, readRetryAfterMs, withRelayerRetry, isRetryableStatus } from "./relayer-http.js";
import { BosphorError, RelayerRequestError } from "./errors.js";

const NOW = Date.parse("2026-09-27T12:00:00Z");

describe("parseRetryAfter", () => {
  it("parses delta seconds into milliseconds", () => {
    assert.equal(parseRetryAfter("30", NOW), 30_000);
    assert.equal(parseRetryAfter(" 5 ", NOW), 5_000);
    assert.equal(parseRetryAfter("0", NOW), 0);
  });

  it("parses an HTTP-date relative to now, clamping the past to 0", () => {
    assert.equal(parseRetryAfter("Sun, 27 Sep 2026 12:00:45 GMT", NOW), 45_000);
    assert.equal(parseRetryAfter("Sun, 27 Sep 2026 11:59:00 GMT", NOW), 0);
  });

  it("returns undefined for a missing or unparseable header", () => {
    assert.equal(parseRetryAfter(null, NOW), undefined);
    assert.equal(parseRetryAfter(undefined, NOW), undefined);
    assert.equal(parseRetryAfter("", NOW), undefined);
    assert.equal(parseRetryAfter("soon", NOW), undefined);
    assert.equal(parseRetryAfter("-3", NOW), undefined);
  });
});

describe("readRetryAfterMs", () => {
  it("reads the header from a fetch-like response, when it has headers", () => {
    const res = { headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "7" : null) } };
    assert.equal(readRetryAfterMs(res), 7_000);
    assert.equal(readRetryAfterMs({}), undefined);
  });
});

describe("isRetryableStatus", () => {
  it("treats 408, 429 and 5xx as transient, other statuses as terminal", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) assert.equal(isRetryableStatus(s), true, `${s}`);
    for (const s of [400, 401, 403, 404, 409, 410, 413, 422]) assert.equal(isRetryableStatus(s), false, `${s}`);
  });
});

describe("RelayerRequestError", () => {
  it("carries status, body and retryAfterMs, and derives retryable from the status", () => {
    const limited = new RelayerRequestError("quote", 429, "slow down", 12_000);
    assert.ok(limited instanceof BosphorError);
    assert.equal(limited.code, "RELAYER_REQUEST_FAILED");
    assert.equal(limited.status, 429);
    assert.equal(limited.body, "slow down");
    assert.equal(limited.retryAfterMs, 12_000);
    assert.equal(limited.retryable, true);
    assert.equal(new RelayerRequestError("quote", 503, "").retryable, true);
    assert.equal(new RelayerRequestError("quote", 400, "bad").retryable, false);
    assert.equal(new RelayerRequestError("quote", 400, "bad").retryAfterMs, undefined);
  });

  it("keeps the historical quote failure message", () => {
    const e = new RelayerRequestError("quote", 500, "boom");
    assert.equal(e.message, "relayer quote failed (500): boom");
  });
});

describe("withRelayerRetry", () => {
  const fast = { baseDelayMs: 1, maxDelayMs: 2, maxElapsedMs: 5_000 };

  it("returns the first success without retrying", async () => {
    let calls = 0;
    const out = await withRelayerRetry(async () => {
      calls++;
      return "ok";
    }, { ...fast, shouldRetry: () => true });
    assert.equal(out, "ok");
    assert.equal(calls, 1);
  });

  it("retries while shouldRetry says so, then succeeds", async () => {
    let calls = 0;
    const out = await withRelayerRetry(async () => {
      calls++;
      if (calls < 3) throw new RelayerRequestError("x", 503, "busy");
      return calls;
    }, { ...fast, shouldRetry: (e) => e instanceof RelayerRequestError && e.retryable });
    assert.equal(out, 3);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0;
    await assert.rejects(
      withRelayerRetry(async () => {
        calls++;
        throw new RelayerRequestError("x", 503, `busy ${calls}`);
      }, { ...fast, maxAttempts: 3, shouldRetry: () => true }),
      /busy 3/,
    );
    assert.equal(calls, 3);
  });

  it("does not retry an error shouldRetry rejects", async () => {
    let calls = 0;
    await assert.rejects(
      withRelayerRetry(async () => {
        calls++;
        throw new RelayerRequestError("x", 409, "done");
      }, { ...fast, shouldRetry: (e) => (e as RelayerRequestError).retryable }),
      /done/,
    );
    assert.equal(calls, 1);
  });

  it("honors Retry-After over the backoff, and gives up when it exceeds the budget", async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await withRelayerRetry(
      async () => {
        calls++;
        if (calls === 1) throw new RelayerRequestError("x", 429, "later", 40);
        return "done";
      },
      { ...fast, shouldRetry: () => true, sleep: async (ms) => void waits.push(ms) },
    );
    assert.equal(out, "done");
    assert.deepEqual(waits, [40]);

    calls = 0;
    await assert.rejects(
      withRelayerRetry(
        async () => {
          calls++;
          throw new RelayerRequestError("x", 429, "much later", 60_000);
        },
        { ...fast, maxElapsedMs: 1_000, shouldRetry: () => true, sleep: async () => {} },
      ),
      /much later/,
    );
    assert.equal(calls, 1, "a Retry-After past the budget fails now instead of sleeping in vain");
  });

  it("rejects with the signal's reason when aborted, without another attempt", async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = withRelayerRetry(
      async () => {
        calls++;
        ac.abort(new Error("user cancelled"));
        throw new RelayerRequestError("x", 503, "busy");
      },
      { baseDelayMs: 50, maxDelayMs: 50, maxElapsedMs: 5_000, shouldRetry: () => true, signal: ac.signal },
    );
    await assert.rejects(p, /user cancelled/);
    assert.equal(calls, 1);
  });
});
