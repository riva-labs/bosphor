import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import {
  createSuiClient,
  createSuiSigner,
  signAndExecute,
  simulateWithOutputs,
} from "./sui-client.js";
import { Transaction } from "@mysten/sui/transactions";

// Raw 32-byte Ed25519 secret key encoded as suiprivkey bech32
// This is a throwaway test key, not used on any network
const TEST_PRIVATE_KEY =
  "suiprivkey1qz87ps595afx22muanws4d5y7fj49nvcavnp4kmv0ykqqu2fk9n2qdw77u0";

describe("createSuiClient", () => {
  it("returns a SuiGrpcClient instance", () => {
    const client = createSuiClient("https://sui-testnet.mystenlabs.com");
    // SuiGrpcClient exposes gRPC service clients
    assert.ok(client.core, "should have core service");
    assert.ok(client.ledgerService, "should have ledgerService");
    assert.ok(client.transactionExecutionService, "should have transactionExecutionService");
    assert.ok(client.subscriptionService, "should have subscriptionService");
  });

  it("reads SUI_GRPC_URL from environment when no url argument given", () => {
    const original = process.env.SUI_GRPC_URL;
    process.env.SUI_GRPC_URL = "https://custom-grpc.example.com";
    try {
      const client = createSuiClient();
      assert.ok(client.core);
    } finally {
      if (original !== undefined) {
        process.env.SUI_GRPC_URL = original;
      } else {
        delete process.env.SUI_GRPC_URL;
      }
    }
  });
});

describe("createSuiSigner", () => {
  it("returns an Ed25519Keypair from a suiprivkey string", () => {
    const signer = createSuiSigner(TEST_PRIVATE_KEY);
    const address = signer.toSuiAddress();
    // Sui addresses are 0x-prefixed 64-char hex strings
    assert.match(address, /^0x[0-9a-f]{64}$/);
  });

  it("returns consistent address for the same key", () => {
    const signer1 = createSuiSigner(TEST_PRIVATE_KEY);
    const signer2 = createSuiSigner(TEST_PRIVATE_KEY);
    assert.equal(signer1.toSuiAddress(), signer2.toSuiAddress());
  });
});

describe("signAndExecute", () => {
  it("builds, signs, and executes a transaction via core.executeTransaction", async () => {
    const signer = createSuiSigner(TEST_PRIVATE_KEY);

    // Stub the client's core.executeTransaction
    const fakeDigest = "FakeDigest123";
    const fakeClient = {
      core: {
        executeTransaction: mock.fn(async () => ({
          transaction: {
            digest: fakeDigest,
            effects: { status: { success: true, error: null } },
          },
        })),
      },
    } as any;

    const tx = new Transaction();
    tx.setSender(signer.toSuiAddress());
    tx.setGasPrice(1000);
    tx.setGasBudget(10_000_000);
    tx.setGasPayment([
      { objectId: "0x" + "aa".repeat(32), version: "1", digest: "CVDFLCAjXhVWiPXH9nTCTpCgVzmDVoiPzNJYuccr1dqB" },
    ]);

    const result = await signAndExecute(fakeClient, tx, signer);

    assert.equal(result.transaction.digest, fakeDigest);
    assert.equal(fakeClient.core.executeTransaction.mock.calls.length, 1);

    // Verify executeTransaction was called with transaction bytes and signatures
    const callArgs = fakeClient.core.executeTransaction.mock.calls[0].arguments[0];
    assert.ok(callArgs.transaction, "should pass transaction bytes");
    assert.ok(callArgs.signatures, "should pass signatures");
    assert.equal(callArgs.signatures.length, 1, "should have one signature");
  });
});

describe("simulateWithOutputs", () => {
  it("calls simulateTransaction with command_outputs in readMask and returns commandOutputs", async () => {
    const senderAddr = "0x" + "bb".repeat(32);

    const fakeOutputs = [
      { returnValues: [{ value: { value: new Uint8Array([1, 2, 3]) } }] },
    ];

    const fakeClient = {
      transactionExecutionService: {
        simulateTransaction: mock.fn(async () => ({
          response: {
            commandOutputs: fakeOutputs,
          },
        })),
      },
    } as any;

    const tx = new Transaction();
    tx.setSender(senderAddr);
    tx.setGasPrice(1000);
    tx.setGasBudget(10_000_000);
    tx.setGasPayment([
      { objectId: "0x" + "cc".repeat(32), version: "1", digest: "CVDFLCAjXhVWiPXH9nTCTpCgVzmDVoiPzNJYuccr1dqB" },
    ]);

    const result = await simulateWithOutputs(fakeClient, tx, senderAddr);

    assert.deepEqual(result, fakeOutputs);
    assert.equal(
      fakeClient.transactionExecutionService.simulateTransaction.mock.calls.length,
      1,
    );

    // Verify the request includes transaction and readMask with commandOutputs
    const callArgs =
      fakeClient.transactionExecutionService.simulateTransaction.mock.calls[0].arguments;
    const request = callArgs[0];
    assert.ok(request.transaction?.bcs?.value, "should pass transaction bcs bytes");
    assert.ok(request.readMask, "should pass readMask");
    assert.ok(
      request.readMask.paths.includes("commandOutputs"),
      "readMask paths should include commandOutputs",
    );
  });
});
