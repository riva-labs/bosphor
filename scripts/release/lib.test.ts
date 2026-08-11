import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSemver,
  formatSemver,
  compareSemver,
  applyBump,
  maxBump,
} from "./lib.ts";

test("parseSemver / formatSemver round-trip", () => {
  assert.deepEqual(parseSemver("1.2.3"), { major: 1, minor: 2, patch: 3 });
  assert.equal(formatSemver({ major: 0, minor: 1, patch: 0 }), "0.1.0");
  assert.throws(() => parseSemver("v1.2.3"));
});

test("compareSemver orders by major, minor, patch", () => {
  assert.ok(compareSemver(parseSemver("0.2.0"), parseSemver("0.1.9")) > 0);
  assert.ok(compareSemver(parseSemver("0.1.0"), parseSemver("0.1.1")) < 0);
  assert.equal(compareSemver(parseSemver("1.0.0"), parseSemver("1.0.0")), 0);
});

test("maxBump picks the higher-ranked bump", () => {
  assert.equal(maxBump("patch", "minor"), "minor");
  assert.equal(maxBump("none", "patch"), "patch");
  assert.equal(maxBump("major", "minor"), "major");
});

test("applyBump follows pre-1.0 rules: breaking bumps minor, not major", () => {
  const v = parseSemver("0.1.3");
  assert.equal(formatSemver(applyBump(v, "patch")), "0.1.4");
  assert.equal(formatSemver(applyBump(v, "minor")), "0.2.0");
  assert.equal(formatSemver(applyBump(v, "major")), "0.2.0"); // pre-1.0 downgrade
  assert.equal(formatSemver(applyBump(v, "none")), "0.1.3");
});

test("applyBump follows normal semver once at 1.0.0+", () => {
  const v = parseSemver("1.4.2");
  assert.equal(formatSemver(applyBump(v, "major")), "2.0.0");
  assert.equal(formatSemver(applyBump(v, "minor")), "1.5.0");
  assert.equal(formatSemver(applyBump(v, "patch")), "1.4.3");
});
