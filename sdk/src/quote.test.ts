import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchQuote } from "./quote.js";
import type { FetchLike } from "./store-flow.js";

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
});
