/**
 * Persisted worker state: one small JSON file per pathway, written atomically.
 * Same layout as bosphor-dvn's src/cursor.ts (cursor-<pathway>.json under
 * DVN_STATE_DIR), so the Solana return worker can share the dvn-state volume
 * with the other DVN workers without colliding (its pathway is "sui_solana").
 *
 * Without a volume the default directory (./data, relative to the working
 * directory) lives in the container's writable layer: the state survives a
 * restart but not a recreate, and the worker re-anchors from chain state.
 * Every read and write failure is non-fatal: an unreadable file reads as
 * "no state", and a failed write is reported to the caller to log.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_STATE_DIR = "./data";

/** The state directory: DVN_STATE_DIR when set and non-empty, else ./data. */
export function stateDir(env: string | undefined = process.env.DVN_STATE_DIR): string {
  return env && env.trim() ? env : DEFAULT_STATE_DIR;
}

export function stateFile(dir: string, pathway: string): string {
  return join(dir, `cursor-${pathway}.json`);
}

/** The saved state, or undefined when absent or unreadable (first boot, no volume, corrupt file). */
export function loadState<T>(dir: string, pathway: string): T | undefined {
  try {
    return JSON.parse(readFileSync(stateFile(dir, pathway), "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** Write the state atomically (tmp + rename). Returns the error instead of throwing. */
export function saveState(dir: string, pathway: string, value: unknown): Error | null {
  try {
    mkdirSync(dir, { recursive: true });
    const f = stateFile(dir, pathway);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(value));
    renameSync(tmp, f);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}
