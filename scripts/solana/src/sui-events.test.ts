import { test } from "node:test";
import assert from "node:assert/strict";
import { bytesFieldToHex } from "./sui-events.ts";

test("base64 vector<u8> (GraphQL) decodes to 0x-hex", () => {
  assert.equal(bytesFieldToHex("AQID/w=="), "0x010203ff");
});

test("number-array vector<u8> (JSON-RPC) still decodes", () => {
  assert.equal(bytesFieldToHex([1, 2, 3, 255]), "0x010203ff");
});

test("0x-hex passes through and empty / missing is null", () => {
  assert.equal(bytesFieldToHex("0xabcd"), "0xabcd");
  assert.equal(bytesFieldToHex(""), null);
  assert.equal(bytesFieldToHex(undefined), null);
});
