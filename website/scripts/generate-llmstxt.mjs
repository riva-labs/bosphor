import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';

const DOCS_DIR = new URL('../docs/', import.meta.url).pathname;
const OUTPUT = new URL('../static/llms-optimized.txt', import.meta.url).pathname;
const TARGET_CHARS = 45_000;

const PINNED_SLUGS = ['intro', 'architecture', 'quickstart'];

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { title: null, body: content };
  const fm = match[1];
  const body = match[2];
  const titleMatch = fm.match(/^title:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].replace(/^["']|["']$/g, '') : null;
  return { title, body };
}

function collectDocs() {
  const files = readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  return files.map((file) => {
    const slug = basename(file, '.md');
    const raw = readFileSync(join(DOCS_DIR, file), 'utf-8');
    const { title, body } = parseFrontmatter(raw);
    return { slug, title: title || slug, body: body.trim() };
  });
}

function buildOutput(docs) {
  const header = [
    '# Bosphor Documentation',
    '> Cross-chain storage intent routing for Walrus',
    '> https://docs.bosphor.xyz',
    '',
  ].join('\n');

  const pinned = [];
  const normal = [];

  for (const doc of docs) {
    if (PINNED_SLUGS.includes(doc.slug)) {
      pinned.push(doc);
    } else {
      normal.push(doc);
    }
  }

  // Reorder pinned to match PINNED_SLUGS order
  pinned.sort(
    (a, b) => PINNED_SLUGS.indexOf(a.slug) - PINNED_SLUGS.indexOf(b.slug),
  );

  function formatSection(doc) {
    return `## ${doc.title}\n\n${doc.body}`;
  }

  const pinnedSections = pinned.map(formatSection);
  const pinnedText = pinnedSections.join('\n\n');
  const usedChars = header.length + pinnedText.length;
  const remaining = TARGET_CHARS - usedChars;

  if (remaining <= 0) {
    // Pinned alone exceeds target, just output pinned
    return header + '\n' + pinnedText;
  }

  const normalSections = normal.map((doc) => ({
    doc,
    text: formatSection(doc),
  }));

  const totalNormal = normalSections.reduce((s, n) => s + n.text.length, 0);

  let finalNormal;
  if (totalNormal <= remaining) {
    // Everything fits
    finalNormal = normalSections.map((n) => n.text);
  } else {
    // Trim proportionally
    const separatorOverhead = normalSections.length * 2; // \n\n between sections
    const availableForContent = remaining - separatorOverhead;
    const ratio = availableForContent / totalNormal;

    finalNormal = normalSections.map((n) => {
      const maxLen = Math.floor(n.text.length * ratio);
      if (n.text.length <= maxLen) return n.text;
      const trimmed = n.text.slice(0, maxLen).trimEnd();
      return trimmed + '\n\n[... trimmed for length]';
    });
  }

  return header + '\n' + pinnedText + '\n\n' + finalNormal.join('\n\n');
}

const docs = collectDocs();
const output = buildOutput(docs);
writeFileSync(OUTPUT, output, 'utf-8');
console.log(
  `Generated ${OUTPUT} (${output.length} chars, ${docs.length} docs)`,
);
