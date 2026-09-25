import { update } from 'fumadocs-core/source';
import { openapi } from './openapi';

/** Base folder of the generated pages, inside the "API reference" section. */
export const apiBaseDir = 'api';

/** `createQuote` -> `create-quote`, so URLs stay lower-case. */
export function kebab(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase();
}

/** First sentence of a Markdown description, as plain text for page metadata. */
export function firstSentence(md: string | undefined): string | undefined {
  if (!md) return undefined;
  const paragraph = md.trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' ').replace(/`/g, '');
  const match = paragraph.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : paragraph).trim();
}

/**
 * Virtual pages for the relayer OpenAPI spec: one page per operation, grouped
 * in a folder per tag (Health, Pricing, Ingest, Status, Meta). The section's
 * own `content/docs/api/meta.json` orders the tag folders after the overview
 * page, so the generated root `meta.json` is dropped.
 */
export async function relayerApiSource() {
  const generated = await openapi.staticSource({
    baseDir: apiBaseDir,
    per: 'operation',
    groupBy: 'tag',
    meta: true,
    name(output) {
      if (output.type !== 'operation') return kebab(output.info.title);
      const { path, method } = output.item;
      const operation = this.document.paths?.[path]?.[method];
      return kebab(operation?.operationId ?? `${method}-${path}`);
    },
  });

  return update(generated)
    .files((files) => files.filter((file) => file.path !== `${apiBaseDir}/meta.json`))
    // Few operations per tag: show them all in the sidebar without a click.
    .meta((file) => ({ ...file, data: { ...file.data, defaultOpen: true } }))
    .page((file) => {
      const { method, path } = file.data.getOpenAPIPageProps().operations?.[0] ?? {};
      const route = method && path ? `${method.toUpperCase()} ${path}` : undefined;
      return {
        ...file,
        data: {
          ...file.data,
          // The full description renders in the page body; the page metadata
          // (search result, link previews, llms.txt) gets its first sentence.
          description: firstSentence(file.data.description),
          structuredData: {
            ...file.data.structuredData,
            contents: [
              // Makes "POST /quote" (and "/quote") findable in search.
              ...(route ? [{ heading: undefined, content: route }] : []),
              ...file.data.structuredData.contents,
            ],
          },
        },
      };
    })
    .build();
}
