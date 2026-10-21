import { test } from "node:test";
import assert from "node:assert/strict";
import { returnDeliveryState } from "./return-delivery.ts";

test("a nonce at or below the inbound frontier whose payload hash account is closed was delivered", () => {
  // lz_receive's Clear closes the payload hash PDA (devnet nonces 3846-3852).
  assert.equal(returnDeliveryState(3846n, { inboundNonce: 3853n, payloadHashExists: false }), "delivered");
  assert.equal(returnDeliveryState(3853n, { inboundNonce: 3853n, payloadHashExists: false }), "delivered");
});

test("a verified nonce whose payload hash account still exists is pending execution", () => {
  assert.equal(returnDeliveryState(3850n, { inboundNonce: 3853n, payloadHashExists: true }), "pending");
});

test("a nonce above the inbound frontier with no payload hash was never verified, so it is pending", () => {
  assert.equal(returnDeliveryState(3854n, { inboundNonce: 3853n, payloadHashExists: false }), "pending");
});

test("an unreadable endpoint state is unknown, never delivered", () => {
  assert.equal(returnDeliveryState(3846n, null), "unknown");
});
