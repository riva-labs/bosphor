// Post-build redirect check. Proves that every URL the two retired sites
// served still lands on a real page of the new build:
//   - every redirect target in redirects/map.mjs exists in out/,
//   - no target is itself redirected (no chains),
//   - every unchanged sdk.bosphor.xyz path still exists,
//   - every Docusaurus doc in website/docs (while that folder exists) has an entry.
//
// Run after `next build`: node scripts/check-redirects.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  legacyDocsSite,
  redirects,
  resolveRedirect,
  unchangedSdkPaths,
} from '../redirects/map.mjs';
import { resolveOutFile } from './out-files.mjs';

const failures = [];

for (const [from, to] of Object.entries(redirects)) {
  if (!resolveOutFile(to)) failures.push(`${from} -> ${to}: target does not exist in out/`);
  if (resolveRedirect(to)) failures.push(`${from} -> ${to}: target is itself redirected`);
  // The same old path with a trailing slash or .html must resolve too.
  for (const variant of [`${from}/`, `${from}.html`]) {
    if (resolveRedirect(variant) !== to) failures.push(`${variant}: does not resolve to ${to}`);
  }
}

for (const p of unchangedSdkPaths) {
  if (!resolveOutFile(p)) failures.push(`${p}: kept path does not exist in out/`);
  if (resolveRedirect(p)) failures.push(`${p}: kept path is also listed as a redirect`);
}

// Every Docusaurus doc id must be covered (website/ is retired in a later step).
const websiteDocs = path.resolve(import.meta.dirname, '..', '..', 'website', 'docs');
if (fs.existsSync(websiteDocs)) {
  for (const name of fs.readdirSync(websiteDocs)) {
    if (!/\.mdx?$/.test(name)) continue;
    const id = name.replace(/\.mdx?$/, '');
    if (!legacyDocsSite[`/${id}`]) failures.push(`website/docs/${name}: no entry for /${id}`);
  }
}

if (failures.length) {
  console.error(`check-redirects: ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(
  `check-redirects: ${Object.keys(redirects).length} redirects and ${unchangedSdkPaths.length} kept paths resolve`,
);
