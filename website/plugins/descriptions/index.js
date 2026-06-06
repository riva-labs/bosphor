// @ts-check
'use strict';

const path = require('path');
const fs = require('fs');
const matter = require('gray-matter');

const DOCS_DIR = path.resolve(__dirname, '..', '..', 'docs');

/**
 * Recursively collect all .md and .mdx files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function collectFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full));
    } else if (/\.mdx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Extract the first paragraph from markdown content (after frontmatter).
 * @param {string} content
 * @returns {string}
 */
function extractFirstParagraph(content) {
  const lines = content.split('\n');
  const paragraphLines = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headings, empty lines before first paragraph, code fences, imports
    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('```') ||
      trimmed.startsWith('import ') ||
      trimmed.startsWith('<!--') ||
      trimmed.startsWith(':::')
    ) {
      if (inParagraph) break;
      continue;
    }

    if (!trimmed) {
      if (inParagraph) break;
      continue;
    }

    inParagraph = true;
    paragraphLines.push(trimmed);
  }

  return paragraphLines.join(' ').slice(0, 200);
}

/**
 * Docusaurus plugin that extracts descriptions from doc frontmatter/content
 * and exposes them via globalData for use by Card components.
 *
 * @param {import('@docusaurus/types').LoadContext} _context
 */
module.exports = function descriptionsPlugin(_context) {
  return {
    name: 'bosphor-descriptions-plugin',

    async contentLoaded({ actions }) {
      const { setGlobalData } = actions;
      const descriptions = {};

      const files = collectFiles(DOCS_DIR);

      for (const filePath of files) {
        try {
          const raw = fs.readFileSync(filePath, 'utf8');
          const { data: frontmatter, content } = matter(raw);

          // Derive slug from file path relative to docs dir
          const relative = path.relative(DOCS_DIR, filePath);
          const slug = relative
            .replace(/\.mdx?$/, '')
            .replace(/\/index$/, '')
            .replace(/\\/g, '/');

          const title =
            frontmatter.title ||
            slug
              .split('/')
              .pop()
              .replace(/-/g, ' ')
              .replace(/\b\w/g, (c) => c.toUpperCase());

          const description =
            frontmatter.description || extractFirstParagraph(content);

          descriptions[slug] = { title, description };
        } catch {
          // Skip files that fail to parse
        }
      }

      setGlobalData({ descriptions });
    },
  };
};
