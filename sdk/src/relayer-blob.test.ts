import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { relayerComputeBlob, MAX_RELAYER_ENCODE_BYTES } from "./relayer-blob.js";
import { createDefaultComputeBlob } from "./blob.js";
import { RelayerRequestError } from "./errors.js";
import { ENCODE_PARITY_INPUTS } from "./relayer-blob.fixtures.js";
import type { FetchLike } from "./store-flow.js";
import { TESTNET } from "./networks.js";

/**
 * `POST /blob/encode` answers recorded from the hosted testnet relayer
 * (https://api.bosphor.xyz/testnet) with `scripts/record-encode-vectors.ts`.
 */
const RECORDED: Record<string, { blobId: string; size: number }> = {
  "one zero byte": { blobId: "ikLkoKbOGH6P7kZyA78_GOJnoOjkbI1lOYH5I77Qi7Y", size: 1 },
  hello: { blobId: "VCHdU3RHtQVBYAI3c30jDhM8PNvrgv7OVxIb8eW6Ih4", size: 5 },
  "bosphor sentence": { blobId: "QNhnTQRSdhqd-4s6L15RcB5VeFqA-D4pFzUWp1m1kD0", size: 36 },
  "4 KiB ramp": { blobId: "hxwiGUrFX3dLC6I_zpMq8XBUpA1iT_RK_q2Tf1b3f6s", size: 4096 },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  };
}

/** A fetch that replays the recorded relayer answer for the posted bytes. */
function recordedFetch(): { fetch: FetchLike; seen: Array<{ url: string; headers: Record<string, string> }> } {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const byLength = new Map(
    ENCODE_PARITY_INPUTS.map((i) => [i.bytes().length, RECORDED[i.name]!] as const),
  );
  const fetchFn: FetchLike = async (url, init) => {
    seen.push({ url, headers: init.headers });
    const hit = byLength.get(init.body!.length);
    return hit ? jsonResponse(201, hit) : jsonResponse(500, "unexpected body");
  };
  return { fetch: fetchFn, seen };
}

describe("relayerComputeBlob", () => {
  it("matches the local @mysten/walrus (WASM) blob id for every recorded input", async () => {
    const wasm = createDefaultComputeBlob("testnet");
    const { fetch } = recordedFetch();
    const relayer = relayerComputeBlob(TESTNET.relayerUrl, { fetch });
    for (const input of ENCODE_PARITY_INPUTS) {
      const [a, b] = await Promise.all([relayer(input.bytes()), wasm(input.bytes())]);
      assert.deepEqual(a, b, `parity for "${input.name}"`);
    }
  });

  it("posts the raw bytes to /blob/encode with the app id header", async () => {
    const { fetch, seen } = recordedFetch();
    const encode = relayerComputeBlob("https://relayer.test/testnet/", { fetch, appId: "my-dapp" });
    const out = await encode(new TextEncoder().encode("hello"));
    assert.equal(out.size, 5);
    assert.equal(out.encodingType, 0);
    assert.equal(seen[0]!.url, "https://relayer.test/testnet/blob/encode");
    assert.equal(seen[0]!.headers["content-type"], "application/octet-stream");
    assert.equal(seen[0]!.headers["X-Bosphor-App"], "my-dapp");
  });

  it("rejects a malformed app id when built, not mid-flow", () => {
    assert.throws(() => relayerComputeBlob("https://relayer.test", { appId: "bad id" }), /invalid appId/);
  });

  it("refuses empty and oversized data before calling the relayer", async () => {
    let called = false;
    const fetchFn: FetchLike = async () => {
      called = true;
      return jsonResponse(201, {});
    };
    const encode = relayerComputeBlob("https://relayer.test", { fetch: fetchFn, maxBytes: 8 });
    await assert.rejects(encode(new Uint8Array(0)), /empty/);
    await assert.rejects(encode(new Uint8Array(9)), /9 bytes.*limit of 8/);
    assert.equal(called, false);
    assert.equal(MAX_RELAYER_ENCODE_BYTES, 10 * 1024 * 1024);
  });

  it("fails loudly when the relayer reports a different size or a malformed id", async () => {
    const wrongSize = relayerComputeBlob("https://relayer.test", {
      fetch: async () => jsonResponse(201, { blobId: RECORDED.hello!.blobId, size: 6 }),
    });
    await assert.rejects(wrongSize(new TextEncoder().encode("hello")), /size 6.*5 bytes/);

    const badId = relayerComputeBlob("https://relayer.test", {
      fetch: async () => jsonResponse(201, { blobId: "AAAA", size: 5 }),
    });
    await assert.rejects(badId(new TextEncoder().encode("hello")), /32-byte Walrus blob id/);

    const notJson = relayerComputeBlob("https://relayer.test", {
      fetch: async () => jsonResponse(201, "<html>"),
    });
    await assert.rejects(notJson(new TextEncoder().encode("hello")), /unparseable/);
  });

  it("surfaces a 429 as a retryable RelayerRequestError with retryAfterMs", async () => {
    const encode = relayerComputeBlob("https://relayer.test", {
      fetch: async () => jsonResponse(429, "rate limit exceeded (encode)", { "retry-after": "20" }),
      retry: false,
    });
    const err = await encode(new Uint8Array([1])).catch((e: unknown) => e);
    assert.ok(err instanceof RelayerRequestError);
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 20_000);
    assert.equal(err.retryable, true);
    assert.equal(err.operation, "blob encode");
  });

  it("retries a 429 or 5xx within its budget, honoring Retry-After", async () => {
    const answers = [
      jsonResponse(429, "slow down", { "retry-after": "0" }),
      jsonResponse(503, "busy"),
      jsonResponse(201, RECORDED.hello),
    ];
    let calls = 0;
    const encode = relayerComputeBlob("https://relayer.test", {
      fetch: async () => answers[calls++]!,
      retry: { baseDelayMs: 1, maxDelayMs: 1 },
    });
    const out = await encode(new TextEncoder().encode("hello"));
    assert.equal(calls, 3);
    assert.equal(out.size, 5);
  });

  it("does not retry a 413 or 400", async () => {
    let calls = 0;
    const encode = relayerComputeBlob("https://relayer.test", {
      fetch: async () => {
        calls++;
        return jsonResponse(413, "too large");
      },
      retry: { baseDelayMs: 1 },
    });
    await assert.rejects(encode(new Uint8Array([1])), (e: unknown) => (e as RelayerRequestError).status === 413);
    assert.equal(calls, 1);
  });

  it("cancels through the per-call signal", async () => {
    const ac = new AbortController();
    ac.abort(new Error("cancelled"));
    const encode = relayerComputeBlob("https://relayer.test", { fetch: recordedFetch().fetch });
    await assert.rejects(encode(new Uint8Array([1]), { signal: ac.signal }), /cancelled/);
  });

  it(
    "live: the hosted relayer agrees with the WASM encoder (opt-in: BOSPHOR_LIVE_TESTS=1)",
    { skip: process.env.BOSPHOR_LIVE_TESTS !== "1" },
    async () => {
      const wasm = createDefaultComputeBlob("testnet");
      const relayer = relayerComputeBlob(process.env.BOSPHOR_RELAYER_URL ?? TESTNET.relayerUrl, {
        appId: "bosphor-sdk-tests",
      });
      for (const input of ENCODE_PARITY_INPUTS.slice(0, 2)) {
        assert.deepEqual(await relayer(input.bytes()), await wasm(input.bytes()), input.name);
      }
    },
  );
});
