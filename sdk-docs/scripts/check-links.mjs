// Post-build link check over the static export. Fails when an internal link
// (href="/...") on any page points at a path the export does not serve, or at a
// heading anchor that does not exist on the target page.
//
// Run after `next build`: node scripts/check-links.mjs
import fs from 'node:fs';
import { listOutFiles, pagePathOf, resolveOutFile } from './out-files.mjs';

const SKIP_PAGES = new Set(['/404', '/_not-found']);

const idCache = new Map();
function idsOf(file) {
  if (!idCache.has(file)) {
    const html = fs.readFileSync(file, 'utf8');
    idCache.set(file, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
  }
  return idCache.get(file);
}

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const broken = [];
let checked = 0;

for (const file of listOutFiles('.html')) {
  const page = pagePathOf(file);
  if (SKIP_PAGES.has(page)) continue;
  const html = fs.readFileSync(file, 'utf8');
  for (const m of html.matchAll(/<a\b[^>]*\shref="([^"]+)"/g)) {
    const href = decode(m[1]);
    if (href.startsWith('#') && href.length > 1) {
      checked++;
      if (!idsOf(file).has(decodeURIComponent(href.slice(1)))) {
        broken.push(`${page}: ${href} (no such anchor on this page)`);
      }
      continue;
    }
    if (!href.startsWith('/') || href.startsWith('//')) continue;
    checked++;
    const [pathAndQuery, hash] = href.split('#');
    const pathname = pathAndQuery.split('?')[0];
    const target = resolveOutFile(pathname);
    if (!target) {
      broken.push(`${page}: ${href} (no such page)`);
      continue;
    }
    if (hash && target.endsWith('.html') && !idsOf(target).has(decodeURIComponent(hash))) {
      broken.push(`${page}: ${href} (no #${hash} on the target page)`);
    }
  }
}

if (broken.length) {
  console.error(`check-links: ${broken.length} broken internal link(s):`);
  for (const b of [...new Set(broken)].sort()) console.error(`  ${b}`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal links OK`);
