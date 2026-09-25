// Helpers shared by the post-build checks: resolve a site path to the file the
// static export (`out/`) serves for it, the same way Workers static assets do
// with html_handling "auto-trailing-slash".
import fs from 'node:fs';
import path from 'node:path';

export const OUT = path.resolve(import.meta.dirname, '..', 'out');

/** The file in out/ that serves `pathname`, or null when nothing does. */
export function resolveOutFile(pathname) {
  let p = decodeURIComponent(pathname);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const candidates =
    p === '/'
      ? ['index.html']
      : [p.slice(1), `${p.slice(1)}.html`, `${p.slice(1)}/index.html`];
  for (const rel of candidates) {
    const file = path.join(OUT, rel);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

/** Every file under out/ with the given extension. */
export function listOutFiles(ext) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) found.push(full);
    }
  };
  walk(OUT);
  return found;
}

/** The site path an out/ HTML file is served at. */
export function pagePathOf(file) {
  const rel = path.relative(OUT, file).replace(/\\/g, '/');
  if (rel === 'index.html') return '/';
  return '/' + rel.replace(/\/index\.html$/, '').replace(/\.html$/, '');
}
