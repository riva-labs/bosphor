import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteEvmStore } from "./evm/quote-store.js";
import type { EthersModuleLike } from "./evm/signer.js";
import { quoteSolanaStore } from "./solana/quote-store.js";
import { resolveStoreSize } from "./quote.js";
import { TESTNET } from "./networks.js";
import type { FetchLike } from "./store-flow.js";

function relayer(seen: { url?: string; body?: Record<string, string | number> }): FetchLike {
  return async (url, init) => {
    seen.url = url;
    seen.body = JSON.parse(new TextDecoder().decode(init.body));
    const fwd = BigInt((seen.body?.forwardLzFeeNative as string) ?? "0");
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          originToken: seen.body?.originToken,
          escrowNative: "1000",
          forwardNative: fwd.toString(),
          totalNative: (1000n + fwd).toString(),
          breakdown: {},
        }),
    };
  };
}

test("resolveStoreSize accepts bytes or a size and rejects empty input", () => {
  assert.equal(resolveStoreSize({ data: new Uint8Array(7) }), 7);
  assert.equal(resolveStoreSize({ sizeBytes: 1024 }), 1024);
  assert.throws(() => resolveStoreSize({ sizeBytes: 0 }), /positive integer/);
  assert.throws(() => resolveStoreSize({ data: new Uint8Array(0) }), /positive integer/);
});

test("quoteEvmStore reads the LZ fee with a provider only and prices via the relayer", async () => {
  const seenContract: { address?: string; runner?: unknown; args?: unknown[] } = {};
  const ethers: EthersModuleLike = {
    Contract: class {
      constructor(address: string, _abi: readonly string[], runner?: never) {
        seenContract.address = address;
        seenContract.runner = runner;
      }
      async quote(...args: unknown[]) {
        seenContract.args = args;
        return { nativeFee: 300n, lzTokenFee: 0n };
      }
    },
  };
  const provider = { provider: null };
  const seen: { url?: string; body?: Record<string, string | number> } = {};
  const quote = await quoteEvmStore({ provider, sizeBytes: 1024, ethers, fetch: relayer(seen) });

  assert.equal(seenContract.address, TESTNET.evm.adapterAddress);
  assert.equal(seenContract.runner, provider);
  assert.equal(seenContract.args?.[0], TESTNET.sui.eid);
  assert.equal(seenContract.args?.[2], 1024);
  assert.equal(seenContract.args?.[4], 5);
  assert.equal(seenContract.args?.[6], TESTNET.evm.lzOptions);
  assert.equal(seen.url, `${TESTNET.relayerUrl}/quote`);
  assert.equal(seen.body?.originToken, "ETH");
  assert.equal(seen.body?.forwardLzFeeNative, "300");
  assert.equal(quote.totalNative, 1300n);
  assert.equal(quote.forwardIsUpperBound, false);
});

test("quoteSolanaStore falls back to the flagged fee cap without the LZ Solana SDK", async () => {
  const seen: { url?: string; body?: Record<string, string | number> } = {};
  const quote = await quoteSolanaStore({
    connection: {},
    data: new Uint8Array(10),
    epochs: 3,
    fetch: relayer(seen),
  });
  assert.equal(seen.body?.originToken, "SOL");
  assert.equal(seen.body?.sizeBytes, 10);
  assert.equal(seen.body?.epochs, 3);
  assert.equal(seen.body?.forwardLzFeeNative, TESTNET.solana.nativeFee.toString());
  assert.equal(quote.forwardIsUpperBound, true);
});
