import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_STATE_DIR, loadState, saveState, stateDir, stateFile } from "./state-file.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "solana-return-state-"));
}

test("stateDir: DVN_STATE_DIR when set, ./data otherwise (works without a volume)", () => {
  assert.equal(stateDir("/data"), "/data");
  assert.equal(stateDir(undefined), DEFAULT_STATE_DIR);
  assert.equal(stateDir("  "), DEFAULT_STATE_DIR);
});

test("saveState/loadState: round trip, in the same file layout as bosphor-dvn", () => {
  const dir = tmp();
  try {
    assert.equal(saveState(join(dir, "nested"), "sui_solana", { eventCursor: "AAEB", lastNonce: "7" }), null);
    assert.equal(stateFile(join(dir, "nested"), "sui_solana"), join(dir, "nested", "cursor-sui_solana.json"));
    assert.deepEqual(loadState(join(dir, "nested"), "sui_solana"), { eventCursor: "AAEB", lastNonce: "7" });
    // Overwrite replaces the whole state.
    saveState(join(dir, "nested"), "sui_solana", { eventCursor: "AAEC" });
    assert.deepEqual(JSON.parse(readFileSync(stateFile(join(dir, "nested"), "sui_solana"), "utf8")), { eventCursor: "AAEC" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadState: an absent or corrupt file reads as no state", () => {
  const dir = tmp();
  try {
    assert.equal(loadState(dir, "sui_solana"), undefined);
    writeFileSync(stateFile(dir, "sui_solana"), "{not json");
    assert.equal(loadState(dir, "sui_solana"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveState: an unwritable directory is reported, not thrown", () => {
  const dir = tmp();
  try {
    const file = join(dir, "a-file");
    writeFileSync(file, "x");
    // A path under a regular file can never be created.
    const err = saveState(join(file, "sub"), "sui_solana", { eventCursor: "AAEB" });
    assert.ok(err instanceof Error);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
