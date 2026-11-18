import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const entry = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/browser-entry.ts");

// Bundles a sample browser dApp (scripts/browser-entry.ts) for platform=browser.
// esbuild fails on any Node built-in it cannot resolve for the browser, so a
// green build means no `fs`, `path`, `crypto`, ... is required. The heavy
// optional peers must stay out: they are lazy-loaded (never bundled) and a
// browser app injects modules or uses the relayer instead.
test("the SDK bundles for the browser without Node built-ins or heavy optional peers", async () => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  assert.deepEqual(result.errors, []);
  const inputs = Object.keys(result.metafile.inputs);
  const heavy = inputs.filter((p) => /@mysten\/walrus|@mysten\/sui|@layerzerolabs/.test(p));
  assert.deepEqual(heavy, [], "no Walrus, Sui or LayerZero SDK in a browser bundle");
  const code = result.outputFiles[0]!.text;
  assert.equal(/\brequire\(["'](fs|path|crypto|os|net|tls|child_process)["']\)/.test(code), false);
});
