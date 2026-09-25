import { loader } from 'fumadocs-core/source';
import { docsContentRoute, docsImageRoute, docsRoute, siteUrl } from './shared';
import { examplesMarkdown } from './examples';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';

const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    // Git-based last-modified time, surfaced as a "Last updated" line per page.
    lastModified: true,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

// See https://fumadocs.dev/docs/headless/source-api for more info
export const source = loader({
  baseUrl: docsRoute,
  source: docs.toFumadocsSource(),
  // Section icons from meta.json `icon` names (the sidebar tabs use them).
  plugins: [lucideIconsPlugin()],
});

export function getPageImageUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: '/' + [page.locale, ...docsImageRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export function getPageMarkdownUrl(page: (typeof source)['$inferPage']) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: '/' + [page.locale, ...docsContentRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export async function getLLMText(page: (typeof source)['$inferPage']) {
  // Components that render data (not prose) get a markdown stand-in, so the
  // markdown twin and llms-full.txt carry the same content as the page.
  const processed = (await page.data.getText('processed')).replace(
    /<ExamplesGallery\s*\/>/g,
    () => examplesMarkdown(siteUrl),
  );

  const description = page.data.description ? `\n> ${page.data.description}\n` : '';

  return `# ${page.data.title}

Source: ${siteUrl}${page.url}
${description}
${processed.trim()}
`;
}
