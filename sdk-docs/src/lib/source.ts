import { loader } from 'fumadocs-core/source';
import { docsContentRoute, docsImageRoute, docsRoute, siteUrl } from './shared';
import { examplesMarkdown } from './examples';
import { defineDocs } from 'fumadocs-mdx/macro';
import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { lucideIconsPlugin } from 'fumadocs-core/source/lucide-icons';
import { openapiPlugin } from 'fumadocs-openapi/server';
import { relayerApiSource } from './api-source';
import { operationToMarkdown } from './openapi-markdown';

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
  source: {
    docs: docs.toFumadocsSource(),
    // One virtual page per relayer operation, under /docs/api/<tag>/<operation>.
    openapi: await relayerApiSource(),
  },
  // Section icons from meta.json `icon` names (the sidebar tabs use them), and
  // HTTP method badges on the API reference entries.
  plugins: [lucideIconsPlugin(), openapiPlugin()],
});

export type DocsPage = (typeof source)['$inferPage'];

export function getPageImageUrl(page: DocsPage) {
  const segments = [...page.slugs, 'image.png'];

  return {
    segments,
    url: '/' + [page.locale, ...docsImageRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export function getPageMarkdownUrl(page: DocsPage) {
  const segments = [...page.slugs, 'content.md'];

  return {
    segments,
    url: '/' + [page.locale, ...docsContentRoute.split('/'), ...segments].filter(Boolean).join('/'),
  };
}

export async function getLLMText(page: DocsPage) {
  // OpenAPI operations render from the spec; components that render data (not
  // prose) get a markdown stand-in, so the markdown twin and llms-full.txt carry
  // the same content as the page.
  const processed =
    page.type === 'openapi'
      ? operationToMarkdown(page.data)
      : (await page.data.getText('processed')).replace(/<ExamplesGallery\s*\/>/g, () =>
          examplesMarkdown(siteUrl),
        );

  const description = page.data.description ? `\n> ${page.data.description}\n` : '';

  return `# ${page.data.title}

Source: ${siteUrl}${page.url}
${description}
${processed.trim()}
`;
}
