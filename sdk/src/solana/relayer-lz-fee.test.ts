import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fetchSolanaLzFee } from "./relayer-lz-fee.js";
import { quoteSolanaStore } from "./quote-store.js";
import { createBosphorSolanaClientFromKeypair } from "./endpoint-accounts.js";
import type { SolanaChain } from "./client.js";
import { BosphorError, RelayerRequestError } from "../errors.js";
import { TESTNET } from "../networks.js";
import type { FetchLike, FetchLikeResponse } from "../store-flow.js";
import type { BlobEncoding } from "../types.js";

const FEE_BODY = { srcEid: 40168, dstEid: 40378, nativeFee: "5911260", quotedAt: 1, maxAgeMs: 30000 };

function res(status: number, body: unknown, headers: Record<string, string> = {}): FetchLikeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  };
}

/**
 * A relayer fake: GET /lz-fee/solana answers `fee`, POST /quote echoes the
 * forward fee it was given. Records every call.
 */
function relayer(fee: FetchLikeResponse) {
  const calls: Array<{ url: string; method: string; body?: Uint8Array | undefined; headers: Record<string, string> }> = [];
  const quotedForward: string[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, headers: init.headers });
    if (url.includes("/lz-fee/solana")) return fee;
    const req = JSON.parse(new TextDecoder().decode(init.body)) as { forwardLzFeeNative: string };
    quotedForward.push(req.forwardLzFeeNative);
    const fwd = BigInt(req.forwardLzFeeNative);
    return res(200, {
      originToken: "SOL",
      escrowNative: "1000",
      forwardNative: fwd.toString(),
      totalNative: (1000n + fwd).toString(),
      breakdown: {},
    });
  };
  return { fetch: fetchFn, calls, quotedForward };
}

describe("fetchSolanaLzFee", () => {
  it("GETs the live fee for the network's pathway, with no body", async () => {
    const r = relayer(res(200, FEE_BODY));
    const fee = await fetchSolanaLzFee("https://relayer.test/testnet/", { fetch: r.fetch, appId: "my-dapp" });
    assert.equal(fee, 5_911_260n);
    assert.equal(r.calls[0]!.url, "https://relayer.test/testnet/lz-fee/solana?dstEid=40378");
    assert.equal(r.calls[0]!.method, "GET");
    assert.equal(r.calls[0]!.body, undefined);
    assert.equal(r.calls[0]!.headers["X-Bosphor-App"], "my-dapp");
  });

  it("throws a RelayerRequestError carrying Retry-After on a 503", async () => {
    const r = relayer(res(503, "simulation failed", { "retry-after": "5" }));
    const err = await fetchSolanaLzFee("https://r", { fetch: r.fetch }).catch((e: unknown) => e);
    assert.ok(err instanceof RelayerRequestError);
    assert.equal(err.status, 503);
    assert.equal(err.retryAfterMs, 5_000);
    assert.equal(err.retryable, true);
  });

  it("refuses a fee for another pathway or a malformed amount", async () => {
    const other = relayer(res(200, { ...FEE_BODY, srcEid: 30168 }));
    await assert.rejects(fetchSolanaLzFee("https://r", { fetch: other.fetch }), (e: unknown) =>
      e instanceof BosphorError && /pathway/.test(e.message),
    );
    const bad = relayer(res(200, { ...FEE_BODY, nativeFee: "-1" }));
    await assert.rejects(fetchSolanaLzFee("https://r", { fetch: bad.fetch }), /nativeFee/);
  });
});

describe("quoteSolanaStore without the LayerZero Solana SDK", () => {
  // `connection: {}` with no injected lzSdk: the optional peer is not installed
  // in the SDK's test environment, exactly like a browser bundle.
  it("uses the relayer's live fee, so the quote is exact, not an upper bound", async () => {
    const r = relayer(res(200, FEE_BODY));
    const q = await quoteSolanaStore({ connection: {}, sizeBytes: 1024, fetch: r.fetch });
    assert.equal(r.quotedForward[0], "5911260");
    assert.equal(q.forwardNative, 5_911_260n);
    assert.equal(q.forwardIsUpperBound, false);
  });

  it("needs no connection at all in that case", async () => {
    const r = relayer(res(200, FEE_BODY));
    const q = await quoteSolanaStore({ sizeBytes: 1024, fetch: r.fetch });
    assert.equal(q.forwardIsUpperBound, false);
  });

  for (const status of [404, 501]) {
    it(`falls back to the flagged fee cap when the relayer answers ${status}`, async () => {
      const r = relayer(res(status, "not here"));
      const q = await quoteSolanaStore({ connection: {}, sizeBytes: 1024, fetch: r.fetch });
      assert.equal(r.quotedForward[0], TESTNET.solana.nativeFee.toString());
      assert.equal(q.forwardIsUpperBound, true);
    });
  }

  it("fails loudly when the relayer cannot quote right now (503)", async () => {
    const r = relayer(res(503, "simulation failed", { "retry-after": "5" }));
    await assert.rejects(
      quoteSolanaStore({ connection: {}, sizeBytes: 1024, fetch: r.fetch }),
      (e: unknown) => e instanceof RelayerRequestError && e.retryAfterMs === 5_000,
    );
  });

  it("skips the relayer fee when relayerLzFee is false", async () => {
    const r = relayer(res(200, FEE_BODY));
    const q = await quoteSolanaStore({ connection: {}, sizeBytes: 1024, fetch: r.fetch, relayerLzFee: false });
    assert.equal(r.calls.some((c) => c.url.includes("/lz-fee/")), false);
    assert.equal(q.forwardIsUpperBound, true);
  });
});

describe("client factory without the LayerZero Solana SDK", () => {
  const chain: SolanaChain = {
    submitIntent: async () => ({ intentId: `0x${"bb".repeat(32)}`, signature: "sig" }),
    readIntent: async () => null,
  };
  const computeBlob = async (d: Uint8Array): Promise<BlobEncoding> => ({
    blobId: `0x${"aa".repeat(32)}`,
    size: d.length,
    encodingType: 0,
  });

  it("prices with the relayer's live fee", async () => {
    const r = relayer(res(200, FEE_BODY));
    const client = await createBosphorSolanaClientFromKeypair({
      connection: {},
      wallet: { publicKey: "Payer" },
      chain,
      computeBlob,
      fetch: r.fetch,
    });
    const q = await client.priceQuote(await client.encode(new Uint8Array([1])));
    assert.equal(q.forwardNative, 5_911_260n);
    assert.equal(q.forwardIsUpperBound, false);
  });
});
