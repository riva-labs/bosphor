// Post-build: give every docs page a markdown twin at its own URL plus ".md"
// (/docs/quickstart -> /docs/quickstart.md, /docs -> /docs.md), the convention
// AI assistants and llms.txt readers expect. The content comes from the
// /llms.mdx/docs/<slug>/content.md route that `next build` already exported, so
// there is one source of truth.
//
// Run after `next build`: node scripts/markdown-aliases.mjs
import fs from 'node:fs';
import path from 'node:path';
import { OUT } from './out-files.mjs';

const SRC = path.join(OUT, 'llms.mdx', 'docs');
let written = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.name === 'content.md') {
      const rel = path.relative(SRC, dir); // "" for /docs, "guides/evm" for a page
      const target = rel ? path.join(OUT, 'docs', `${rel}.md`) : path.join(OUT, 'docs.md');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(full, target);
      written++;
    }
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`markdown-aliases: ${SRC} is missing; run next build first`);
  process.exit(1);
}
walk(SRC);
if (written === 0) {
  console.error('markdown-aliases: no content.md files found');
  process.exit(1);
}
console.log(`markdown-aliases: wrote ${written} .md page(s)`);
