import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchQuote } from "./quote.js";
import type { FetchLike } from "./store-flow.js";
import { BosphorError, RelayerRequestError } from "./errors.js";

const RESPONSE = {
  originToken: "ETH",
  escrowNative: "821242000000000",
  forwardNative: "1251000000000000",
  totalNative: "2072242000000000",
  breakdown: {
    walCostUsd: 0.0010452,
    returnLzUsd: 1.408,
    suiGasUsd: 0.008,
    forwardLzUsd: 3.0275,
    originGasUsd: 0.1,
    bufferedEscrowUsd: 1.7853097,
    serviceMarginUsd: 0.2677965,
    escrowUsd: 2.0531062,
    forwardUsd: 3.1275,
    totalUsd: 5.1806062,
    floorApplied: false,
  },
};

describe("fetchQuote", () => {
  it("posts the request and parses bigint amounts from strings", async () => {
    let seenUrl = "";
    let seenBody = "";
    const fetchFn: FetchLike = async (url, init) => {
      seenUrl = url;
      seenBody = new TextDecoder().decode(init.body);
      return { ok: true, status: 200, text: async () => JSON.stringify(RESPONSE) };
    };

    const q = await fetchQuote(
      "https://relayer.example/testnet/",
      {
        sizeBytes: 1024 * 1024,
        originToken: "ETH",
        forwardLzFeeNative: 1_211_000_000_000_000n,
        originGasNative: 40_000_000_000_000n,
      },
      { fetch: fetchFn },
    );

    assert.equal(seenUrl, "https://relayer.example/testnet/quote");
    const parsed = JSON.parse(seenBody);
    assert.equal(parsed.sizeBytes, 1024 * 1024);
    assert.equal(parsed.forwardLzFeeNative, "1211000000000000");
    assert.equal(q.escrowNative, 821242000000000n);
    assert.equal(q.totalNative, 2072242000000000n);
    assert.equal(q.breakdown.escrowUsd, 2.0531062);
    assert.equal(q.breakdown.floorApplied, false);
  });

  it("sends the app id as X-Bosphor-App when given, and nothing otherwise", async () => {
    const seen: Record<string, string>[] = [];
    const fetchFn: FetchLike = async (_url, init) => {
      seen.push(init.headers);
      return { ok: true, status: 200, text: async () => JSON.stringify(RESPONSE) };
    };
    const req = { sizeBytes: 10, originToken: "ETH" as const };
    await fetchQuote("https://relayer.example", req, { fetch: fetchFn, appId: "my-dapp" });
    await fetchQuote("https://relayer.example", req, { fetch: fetchFn });
    assert.equal(seen[0]!["X-Bosphor-App"], "my-dapp");
    assert.equal(seen[0]!["content-type"], "application/json");
    assert.equal(seen[1]!["X-Bosphor-App"], undefined);
  });

  it("rejects a malformed app id before calling the relayer", async () => {
    let called = false;
    const fetchFn: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => JSON.stringify(RESPONSE) };
    };
    await assert.rejects(
      fetchQuote(
        "https://relayer.example",
        { sizeBytes: 10, originToken: "ETH" },
        { fetch: fetchFn, appId: "bad id" },
      ),
      /invalid appId/,
    );
    assert.equal(called, false);
  });

  it("throws BosphorError on a non-2xx response (no fabricated quote)", async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 503,
      text: async () => "oracle down",
    });
    await assert.rejects(
      () => fetchQuote("https://relayer.example", { sizeBytes: 1, originToken: "ETH" }, { fetch: fetchFn }),
      /relayer quote failed \(503\)/,
    );
  });

  it("exposes retryAfterMs and retryable on a 429, from Retry-After seconds", async () => {
    const fetchFn: FetchLike = async () => ({
      ok: false,
      status: 429,
      text: async () => '{"statusCode":429,"message":"rate limit exceeded (ip); retry after 12s"}',
      headers: { get: (n: string) => (n === "retry-after" ? "12" : null) },
    });
    const err = await fetchQuote(
      "https://relayer.example",
      { sizeBytes: 1, originToken: "ETH" },
      { fetch: fetchFn },
    ).catch((e: unknown) => e);
    assert.ok(err instanceof RelayerRequestError);
    assert.ok(err instanceof BosphorError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 12_000);
    assert.equal(err.retryable, true);
    assert.equal(err.code, "RELAYER_REQUEST_FAILED");
  });

  it("marks a 400 as not retryable and leaves retryAfterMs undefined", async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 400, text: async () => "bad" });
    const err = (await fetchQuote(
      "https://relayer.example",
      { sizeBytes: 1, originToken: "ETH" },
      { fetch: fetchFn },
    ).catch((e: unknown) => e)) as RelayerRequestError;
    assert.equal(err.retryable, false);
    assert.equal(err.retryAfterMs, undefined);
  });

  for (const status of [200, 201]) {
    it(`accepts a ${status} quote response (new and old relayers)`, async () => {
      const fetchFn: FetchLike = async () => ({
        ok: true,
        status,
        text: async () => JSON.stringify(RESPONSE),
      });
      const q = await fetchQuote(
        "https://relayer.example",
        { sizeBytes: 1, originToken: "ETH" },
        { fetch: fetchFn },
      );
      assert.equal(q.totalNative, 2072242000000000n);
    });
  }
});
