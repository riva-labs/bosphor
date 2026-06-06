// @ts-check
'use strict';

const { visit } = require('unist-util-visit');
const path = require('path');
const fs = require('fs');

const glossaryPath = path.resolve(__dirname, '..', 'static', 'glossary.json');

/** @type {Array<{term: string, id: string, aliases?: string[], description: string}>} */
let glossaryTerms = [];
try {
  glossaryTerms = JSON.parse(fs.readFileSync(glossaryPath, 'utf8'));
} catch {
  console.warn('[remark-glossary] Could not read glossary.json');
}

/**
 * Build a list of all matchable strings (term + aliases) with their metadata.
 * Sorted by length descending so longer terms match first.
 */
const matchEntries = glossaryTerms
  .flatMap((entry) => {
    const names = [entry.term, ...(entry.aliases || [])];
    return names.map((name) => ({
      pattern: name,
      id: entry.id,
      regex: new RegExp(
        `\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
        'i',
      ),
    }));
  })
  .sort((a, b) => b.pattern.length - a.pattern.length);

/**
 * Node types to skip when scanning for glossary terms.
 */
const SKIP_TYPES = new Set([
  'code',
  'inlineCode',
  'link',
  'heading',
  'mdxJsxFlowElement',
  'mdxJsxTextElement',
]);

/**
 * Remark plugin that wraps the first occurrence of each glossary term
 * on a page with a <Term> MDX component.
 */
function remarkGlossary() {
  return (tree, file) => {
    // Skip the glossary page itself
    const filePath = file.history?.[0] || '';
    if (filePath.endsWith('glossary.md') || filePath.endsWith('glossary.mdx')) {
      return;
    }

    /** Track which term IDs have already been wrapped on this page */
    const wrapped = new Set();

    visit(tree, 'text', (node, index, parent) => {
      if (!parent || index === undefined) return;

      // Skip if inside a node type we should not touch
      if (SKIP_TYPES.has(parent.type)) return;

      const text = node.value;
      if (!text || !text.trim()) return;

      // Try each term, find the first match that has not been wrapped yet
      for (const entry of matchEntries) {
        if (wrapped.has(entry.id)) continue;

        const match = entry.regex.exec(text);
        if (!match) continue;

        wrapped.add(entry.id);

        const before = text.slice(0, match.index);
        const matched = text.slice(match.index, match.index + match[0].length);
        const after = text.slice(match.index + match[0].length);

        const newNodes = [];

        if (before) {
          newNodes.push({ type: 'text', value: before });
        }

        newNodes.push({
          type: 'mdxJsxTextElement',
          name: 'Term',
          attributes: [
            {
              type: 'mdxJsxAttribute',
              name: 'id',
              value: entry.id,
            },
          ],
          children: [{ type: 'text', value: matched }],
          data: { _mdxExplicitJsx: true },
        });

        if (after) {
          newNodes.push({ type: 'text', value: after });
        }

        parent.children.splice(index, 1, ...newNodes);

        // Stop looking for more terms in this (now-split) node
        return;
      }
    });
  };
}

module.exports = remarkGlossary;
