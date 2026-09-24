import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { presetEid, presetEnv, resolveNetwork, suiJsonRpcUrls } from "./network.js";

describe("resolveNetwork", () => {
  it("defaults to testnet", () => {
    assert.equal(resolveNetwork({}), "testnet");
  });
  it("rejects unknown values", () => {
    assert.throws(() => resolveNetwork({ NETWORK: "devnet" }), /NETWORK must be/);
  });
});

describe("testnet preset (unchanged historical defaults)", () => {
  it("falls back to Sepolia and Sui testnet", () => {
    assert.equal(presetEnv("LZ_ENDPOINT_ADDRESS", "testnet", {}), "0x6EDCE65403992e310A62460808c4b910D972f10f");
    assert.equal(presetEid("EVM_EID", "testnet", {}), 40161);
    assert.equal(presetEid("SUI_EID", "testnet", {}), 40378);
    assert.equal(presetEnv("SUI_GRPC_URL", "testnet", {}), "https://sui-testnet.mystenlabs.com");
    assert.deepEqual(suiJsonRpcUrls("testnet", {}), [
      "https://sui-testnet-rpc.publicnode.com",
      "https://rpc-testnet.suiscan.xyz",
    ]);
  });
  it("still honors explicit env", () => {
    assert.equal(presetEid("EVM_EID", "testnet", { EVM_EID: "40245" }), 40245);
  });
});

describe("mainnet preset (no testnet fallbacks)", () => {
  it("requires the EVM chain, endpoint and RPCs", () => {
    assert.throws(() => presetEid("EVM_EID", "mainnet", {}), /EVM_EID must be set/);
    assert.throws(() => presetEnv("LZ_ENDPOINT_ADDRESS", "mainnet", {}), /LZ_ENDPOINT_ADDRESS must be set/);
    assert.throws(() => presetEnv("SUI_GRPC_URL", "mainnet", {}), /SUI_GRPC_URL must be set/);
    assert.throws(() => suiJsonRpcUrls("mainnet", {}), /SUI_JSONRPC_URL must be set/);
  });
  it("presets the canonical Sui mainnet EID", () => {
    assert.equal(presetEid("SUI_EID", "mainnet", {}), 30378);
  });
  it("accepts any mainnet EVM chain and rejects testnet EIDs", () => {
    for (const eid of ["30101", "30184", "30110"]) {
      assert.equal(presetEid("EVM_EID", "mainnet", { EVM_EID: eid }), Number(eid));
    }
    assert.throws(() => presetEid("EVM_EID", "mainnet", { EVM_EID: "40161" }), /not a LayerZero mainnet EID/);
  });
  it("uses only the explicit Sui JSON-RPC", () => {
    assert.deepEqual(suiJsonRpcUrls("mainnet", { SUI_JSONRPC_URL: "https://rpc.example" }), [
      "https://rpc.example",
    ]);
  });
});
