import { test } from "node:test";
import assert from "node:assert/strict";
import * as core from "./index.js";
import * as evm from "./evm/index.js";
import * as solana from "./solana/index.js";

// The integrator-facing surface each entry point must expose. Starter repos and the
// docs import these by name, so a missing re-export is a breaking change.
const SHARED = ["TESTNET", "networks", "walrusBlobUrl", "blobIdToBase64Url", "fetchQuote"];

test("core entry exports the preset and quote client", () => {
  for (const name of SHARED) assert.ok(name in core, `@bosphor/sdk is missing ${name}`);
});

test("evm entry exports the preset, quote client, ABI, and signer helpers", () => {
  for (const name of [
    ...SHARED,
    "ADAPTER_ABI",
    "EscrowStatus",
    "connectAdapter",
    "createBosphorClientFromSigner",
    "createBosphorClient",
    "fromEthersContract",
    "quoteEvmStore",
  ]) {
    assert.ok(name in evm, `@bosphor/sdk/evm is missing ${name}`);
  }
});

test("solana entry exports the preset, quote client, and send-account helpers", () => {
  for (const name of [
    ...SHARED,
    "TESTNET_SEND_ACCOUNTS",
    "testnetEndpointAccounts",
    "resolveEndpointAccounts",
    "createBosphorSolanaClientFromKeypair",
    "createDefaultSolanaChain",
    "BOSPHOR_PROGRAM_ID",
    "quoteSolanaStore",
    "quoteSolanaLzFee",
    "LzSolanaSdkMissingError",
  ]) {
    assert.ok(name in solana, `@bosphor/sdk/solana is missing ${name}`);
  }
  assert.equal(solana.BOSPHOR_PROGRAM_ID, solana.TESTNET.solana.programId);
});
